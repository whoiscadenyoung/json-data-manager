import { slugifyViewName } from "@caden/data-core/views";
import { z } from "zod";

import type { VerifiedClaims } from "./claims";
import { readAs, type Json, type RunnerDeps, type Tx } from "./runner";
import { guardScratchSql } from "./scratch-guard";

/**
 * The Scratch query (#306; docs/views-design.md §9): one-off SQL over the
 * project's datasets and views, in the SAME dialect and CTE layout a saved
 * `sql` step uses. Each readable project dataset is exposed as a CTE named
 * `in_<slug>` with the compiler's input layout `(row_id uuid, d jsonb, geom
 * geometry)`; `<slug>` is the slugified title, de-duplicated with `_2`, `_3`.
 * The `<slug>` doubles as the input ALIAS when the query is saved as a view,
 * so the saved step runs unchanged.
 *
 * The query runs through `readAs` (the runner's phase 1): verified claims,
 * `authenticated` role (RLS), read-only always-rolled-back transaction,
 * statement timeout. The user's SQL is wrapped as a subquery
 * (`select * from (<sql>) scratch`), so a stacked statement is a syntax error
 * and the user's own `WITH` still works.
 */

export const SCRATCH_ROW_LIMIT = 1_000;
export const SCRATCH_TIMEOUT_MS = 15_000;

export interface ScratchTable {
  /** The SQL name: `in_<slug>`. */
  name: string;
  /** The input alias a saved view uses (`<slug>`). */
  alias: string;
  datasetId: string;
  title: string;
  kind: "source" | "view";
  fields: string[];
}

export type ScratchOutcome =
  | {
      ok: true;
      columns: string[];
      rows: Record<string, Json>[];
      rowCount: number;
      truncated: boolean;
      elapsedMs: number;
    }
  | { ok: false; error: string; code: string | null; elapsedMs: number };

export interface ScratchResult {
  tables: ScratchTable[];
  /** Undefined when only the table list was requested. */
  outcome?: ScratchOutcome;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const catalogRow = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["source", "view"]),
  fields: z.array(z.unknown()),
});

/** Stable, unique aliases for titles (input order decides who keeps the bare slug). */
export function aliasesFor(titles: readonly string[]): string[] {
  const taken = new Set<string>();
  return titles.map((title) => {
    const base = slugifyViewName(title);
    let alias = base;
    let n = 2;
    while (taken.has(alias)) {
      alias = `${base}_${n}`;
      n += 1;
    }
    taken.add(alias);
    return alias;
  });
}

/** The project's datasets and views the caller can read (RLS), as scratch tables. */
export async function loadScratchTables(tx: Tx, projectId: string): Promise<ScratchTable[]> {
  if (!UUID.test(projectId)) {
    throw new Error("Invalid project id.");
  }
  const rows = await tx.unsafe(
    `select d.id::text as id, d.title, d.kind, coalesce(d.properties, '[]'::jsonb) as fields
     from public.project_artifacts pa
     join public.datasets d on d.id::text = pa.artifact_id
     where pa.project_id = $1::uuid and pa.artifact_kind = 'dataset'
     order by lower(d.title), d.id`,
    [projectId],
  );
  const parsed = rows.map((row) => catalogRow.parse(Object.fromEntries(Object.entries(row))));
  const aliases = aliasesFor(parsed.map((row) => row.title));
  return parsed.map((row, index) => {
    const alias = aliases[index] ?? "input";
    return {
      name: `in_${alias}`,
      alias,
      datasetId: row.id,
      title: row.title,
      kind: row.kind,
      fields: row.fields.filter((field): field is string => typeof field === "string"),
    };
  });
}

/** `with "in_x" as (...), ...` over the compiler's input layout (empty when there are no tables). */
export function scratchPrelude(tables: readonly ScratchTable[]): string {
  if (tables.length === 0) {
    return "";
  }
  const ctes = tables.map((table) => {
    if (!UUID.test(table.datasetId)) {
      throw new Error("Invalid dataset id.");
    }
    return `"${table.name.replaceAll('"', '""')}" as (
  select e.id as row_id, e.data as d, g.geom as geom
  from public.entries e
  left join public.geometries g on g.entry_id = e.id
  where e.dataset_id = '${table.datasetId}'::uuid
)`;
  });
  return `with ${ctes.join(",\n")}\n`;
}

/** The statement Postgres runs for the user's SQL (exported for tests). */
export function wrapScratch(tables: readonly ScratchTable[], userSql: string): string {
  return `${scratchPrelude(tables)}select * from (\n${userSql}\n) as scratch`;
}

interface PgErrorLike {
  message: string;
  code?: string;
}

function pgErrorOf(error: unknown): PgErrorLike {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String(error.message);
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return code === undefined ? { message } : { message, code };
  }
  return { message: String(error) };
}

function friendlyError(error: PgErrorLike, timeoutMs: number): string {
  if (error.code === "57014" && /statement timeout/i.test(error.message)) {
    return `The query ran longer than ${Math.round(timeoutMs / 1000)} seconds and was cancelled (timeout). Add a filter or a LIMIT, or save it as a view and run it there.`;
  }
  if (error.code === "25006") {
    return "Scratch queries are read-only: nothing here can change data.";
  }
  if (error.code === "42P01") {
    return `${error.message}. Use the table names listed beside the editor (in_<name>).`;
  }
  return error.message;
}

const rowRecord = z.record(z.string(), z.json());

async function runWrapped(
  tx: Tx,
  wrapped: string,
  maxRows: number,
): Promise<{ columns: string[]; rows: Record<string, Json>[]; truncated: boolean }> {
  // Column ORDER comes from a zero-row run (to_jsonb loses it).
  const shape = await tx.unsafe(`select * from (${wrapped}) q limit 0`);
  const columns = shape.columns.map((column) => column.name);
  const data = await tx.unsafe(`select to_jsonb(q) as r from (${wrapped}) q limit ${maxRows + 1}`);
  const rows = data.map((row) => rowRecord.parse(row["r"]));
  const truncated = rows.length > maxRows;
  return { columns, rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
}

/**
 * Lists the scratch tables and, when `sql` is given, runs it. Query failures
 * (syntax, permission, timeout, write attempts) come back as `ok: false`
 * with Postgres's message, not as a thrown server error.
 */
export async function scratchAs(
  deps: RunnerDeps,
  who: VerifiedClaims,
  projectId: string,
  sql: string | undefined,
  options: { maxRows?: number; timeoutMs?: number } = {},
): Promise<ScratchResult> {
  const timeoutMs = Math.min(deps.timeoutMs, options.timeoutMs ?? SCRATCH_TIMEOUT_MS);
  const maxRows = options.maxRows ?? SCRATCH_ROW_LIMIT;
  const started = performance.now();
  const guarded = sql === undefined ? undefined : guardScratchSql(sql);
  return await readAs({ ...deps, timeoutMs }, who, async (tx) => {
    const tables = await loadScratchTables(tx, projectId);
    if (guarded === undefined) {
      return { tables };
    }
    if (!guarded.ok) {
      return {
        tables,
        outcome: { ok: false, error: guarded.error, code: null, elapsedMs: 0 } as const,
      };
    }
    try {
      const result = await runWrapped(tx, wrapScratch(tables, guarded.sql), maxRows);
      const elapsedMs = Math.round(performance.now() - started);
      return {
        tables,
        outcome: { ok: true, ...result, rowCount: result.rows.length, elapsedMs } as const,
      };
    } catch (error) {
      const pg = pgErrorOf(error);
      return {
        tables,
        outcome: {
          ok: false,
          error: friendlyError(pg, timeoutMs),
          code: pg.code ?? null,
          elapsedMs: Math.round(performance.now() - started),
        } as const,
      };
    }
  });
}
