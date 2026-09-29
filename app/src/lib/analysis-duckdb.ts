/**
 * The analysis layer's SQL engine handle (roadmap stage 9, #105) — a lazily
 * created DuckDB-WASM `SqlEngine` (the injected fourth argument of
 * `applySql`, packages/json-cms/src/shared/transform/sql.ts).
 *
 * Build-time decisions, recorded per the issue's deferrals:
 * - **Lazy.** The WASM bundle (and this module's dynamic imports) load only
 *   when a caller first asks for the engine — the analysis surface opening,
 *   or a publish whose spec actually carries a sql operation. No analysis
 *   byte ships in the initial bundle graph.
 * - **Single-threaded.** The pthread build (COOP/COEP headers) is the
 *   multi-threaded option; this app sets no cross-origin isolation headers,
 *   so `instantiate` gets a null pthread worker — decided here, once, and
 *   revisitable without touching a caller.
 * - **Capped.** `memory_limit` is set on every connection (an analysis must
 *   not OOM the tab); the result-row cap is `applySql`'s `limit` option,
 *   owned by the callers (worker + publish path), not hardcoded here.
 *
 * Runs identically in the analysis Web Worker (interactive runs) and on the
 * main thread (publish/preview parity — bundle-publish.ts's rule that spec
 * execution is client-side compute with no worker prerequisite): DuckDB's
 * own engine worker is spawned inside whichever context asks. This module
 * must stay React-free and seam-clean — it imports DuckDB and Arrow, and
 * nothing about datasets at all (rows arrive already materialized).
 */
import { tableFromArrays } from "apache-arrow";
import type { Table as ArrowTable } from "apache-arrow";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { SqlEngine, SqlTable } from "@caden/json-cms/transform";

/** The DuckDB memory cap per engine instance (the build-time cap the issue names). */
const MEMORY_LIMIT = "1GB";

let enginePromise: Promise<SqlEngine> | undefined;

/**
 * The process-wide (per-context) engine: one WASM instance per worker or
 * tab, created on first call. Consecutive calls share it — the registration
 * contract is create-or-replace, so sequential runs cannot see each other's
 * tables under the same names.
 */
export async function analysisSqlEngine(): Promise<SqlEngine> {
  enginePromise ??= createEngine();
  return enginePromise;
}

/**
 * The DuckDB-WASM assets, as Vite `?url` imports so nothing fetches a CDN at
 * runtime. Built INSIDE `createEngine` — the dynamic imports (and the glue
 * chunks they pull in) must not fire at module evaluation, or merely
 * visiting any dataset page would download DuckDB against the lazy-load
 * invariant this module documents.
 */
async function duckdbBundles() {
  return await Promise.all([
    import("@duckdb/duckdb-wasm"),
    import("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url"),
  ] as const);
}

async function createEngine(): Promise<SqlEngine> {
  const [
    duckdb,
    { default: mvpModule },
    { default: mvpWorker },
    { default: ehModule },
    { default: ehWorker },
  ] = await duckdbBundles();
  const bundle = await duckdb.selectBundle({
    eh: { mainModule: ehModule, mainWorker: ehWorker },
    mvp: { mainModule: mvpModule, mainWorker: mvpWorker },
  });
  // The bundle's worker scripts are classic scripts; the documented bundler
  // path wraps the URL in an importScripts blob (a module worker cannot
  // importScripts its own URL, and the blob sidesteps that).
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  const db = new duckdb.AsyncDuckDB(
    new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
    new Worker(workerUrl),
  );
  // Single-threaded by decision (see the module doc): pthreadWorker null.
  await db.instantiate(bundle.mainModule, null);
  const connection = await db.connect();
  await connection.query(`SET memory_limit='${MEMORY_LIMIT}'`);
  return new DuckDbEngine(db, connection);
}

/** The JS value one Arrow cell arrives as, normalized into serializable plain data. Exported pure for `analysis-duckdb.test.ts` — the engine's WASM path can't run under vitest, but this policy can be pinned. */
export function normalizeArrowValue(value: unknown): unknown {
  // DuckDB's COUNT/sum aggregates arrive as BigInt (INT64) — fine inside the
  // worker, wrong in a preview/registry spec (JSON.stringify throws). Safe
  // integers narrow to numbers; anything wider keeps its string form honest.
  if (typeof value === "bigint") {
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  return value;
}

/** The materialized `SqlTable` as an Arrow table — the doc-named fast registration path (analysis-layer-design.md §2:46). `tableFromArrays` infers each column's type from the cells, which materializeSqlTable already made homogeneous under the 0.4 policies (sql.ts): number columns are numeric-or-null, string columns are normalized-key text, boolean columns booleans. */
function arrowTableOf(table: SqlTable): ArrowTable {
  const arrays: Record<string, unknown[]> = {};
  for (const column of table.columns) {
    arrays[column.name] = table.rows.map((row) => row[column.name]);
  }
  return tableFromArrays(arrays);
}

class DuckDbEngine implements SqlEngine {
  constructor(
    private readonly db: AsyncDuckDB,
    private readonly connection: AsyncDuckDBConnection,
  ) {}

  /** Drops the previous occupant of `name`, whatever kind it was — a view when a query created one, a table when Arrow did. */
  async #dropExisting(name: string): Promise<void> {
    const quoted = `"${name.replaceAll('"', '""')}"`,
      literal = `'${name.replaceAll("'", "''")}'`;
    const existing = await this.connection.query(
      `SELECT table_type FROM information_schema.tables WHERE table_schema = 'main' AND table_name = ${literal}`,
    );
    const firstRow = existing.toArray()[0];
    const kind: unknown = firstRow === undefined ? undefined : firstRow.table_type;
    if (typeof kind !== "string") {
      return;
    }
    await this.connection.query(kind === "VIEW" ? `DROP VIEW ${quoted}` : `DROP TABLE ${quoted}`);
  }

  async register(table: SqlTable): Promise<void> {
    // Create-or-replace: two runs of one query must not see each other's
    // tables under the same name (the SqlEngine contract, sql.ts). The kind
    // check (not blind IF EXISTS) is DuckDB's rule — DROP TABLE refuses a
    // view and vice versa, even with IF EXISTS.
    await this.#dropExisting(table.name);
    await this.connection.insertArrowTable(arrowTableOf(table), {
      create: true,
      name: table.name,
    });
  }

  async query(sql: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.connection.query(sql),
      names = result.schema.fields.map((field) => field.name),
      rows: Array<Record<string, unknown>> = [];
    for (const row of result.toArray()) {
      const record: Record<string, unknown> = {};
      for (const name of names) {
        record[name] = normalizeArrowValue(row[name]);
      }
      rows.push(record);
    }
    return rows;
  }

  /** The engine behind this handle (test/inspection seam; unused in app flow today). */
  get bindings(): AsyncDuckDB {
    return this.db;
  }
}

/** Test hook: forget the memoized engine so a later call builds a fresh one (never used in app flow). */
export function resetAnalysisSqlEngineForTests(): void {
  enginePromise = undefined;
}
