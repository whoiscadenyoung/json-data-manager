import type { SqlEngine, SqlTable } from "@caden/json-cms/transform";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
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
 * - **Locked down (#132).** A saved analysis runs in each viewer's browser,
 *   so right after instantiation the engine gets external access disabled,
 *   extension autoinstall/autoload disabled, and its configuration locked
 *   — a `read_csv('https://…')` in a shared analysis must fail closed, not
 *   fetch. The probe record lives on `ENGINE_LOCKDOWN_STATEMENTS`; the
 *   applier swallows an unsupported setting rather than failing startup.
 *   The pure statement gate in json-cms sql.ts is the host-independent
 *   layer on top of this (the pinned build exposes no statement-extraction
 *   API to prefer over it — verified 2026-09-30, see below).
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

/** The DuckDB memory cap per engine instance (the build-time cap the issue names). */
const MEMORY_LIMIT = "1GB";

/**
 * The post-init lockdown (#132), in application order: external access off
 * first (kills remote reads and ATTACH), then the extension gates (no
 * surprise INSTALL/LOAD), and `lock_configuration` LAST — after it every
 * further SET fails, so the lockdown cannot be undone by a query.
 * `memory_limit` is deliberately absent: it must run BEFORE the lock, and
 * `createEngine` sets it immediately before calling the applier.
 *
 * Probe record, 2026-09-30, against this exact pin
 * (`@duckdb/duckdb-wasm` 1.33.1-dev57.0 — its wasm embeds engine v1.5.4;
 * probed on the package's own Node target under bun, stdout in the PR):
 * all four statements apply cleanly; afterwards a remote
 * `read_csv('https://…')` fails with a Permission Error,
 * `read_parquet`/`parquet_scan` with a Catalog Error (the extension is no
 * longer autoloaded), `LOAD httpfs` with a Permission Error, `ATTACH
 * 'https://…'` with a Permission Error, and a further `SET` with "Invalid
 * Input Error: Cannot change configuration option". Should a future pin
 * drop one of these settings, startup must not break — `applyEngineLockdown`
 * swallows a failed statement and moves on; the pure statement gate in
 * json-cms sql.ts remains the host-independent second layer.
 */
export const ENGINE_LOCKDOWN_STATEMENTS: readonly string[] = [
  "SET enable_external_access = false",
  "SET autoinstall_known_extensions = false",
  "SET autoload_known_extensions = false",
  "SET lock_configuration = true",
];

/** The connection surface the lockdown needs (the subset of `AsyncDuckDBConnection`). */
export interface LockdownConnection {
  query(sql: string): Promise<unknown>;
}

/**
 * Applies `ENGINE_LOCKDOWN_STATEMENTS` in order, tolerating a statement the
 * connected engine does not support (see the probe record above): one
 * unsupported setting must not fail engine startup, so a per-statement
 * failure is swallowed and the remaining lockdown still applies. Exported
 * next to `normalizeArrowValue` for `analysis-duckdb.test.ts`, which pins
 * both the order and the tolerance against stand-ins.
 */
export async function applyEngineLockdown(connection: LockdownConnection): Promise<void> {
  for (const statement of ENGINE_LOCKDOWN_STATEMENTS) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each setting must apply before the next (lock_configuration last); order is the lockdown.
      await connection.query(statement);
    } catch {
      // Unsupported on this engine build — continue with the remaining
      // lockdown statements (the probe comment on ENGINE_LOCKDOWN_STATEMENTS
      // records which settings the pinned build accepts).
    }
  }
}

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
  // The lockdown (#132) runs before any caller query; lock_configuration
  // (last) freezes these settings in place for the engine's lifetime.
  await applyEngineLockdown(connection);
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
