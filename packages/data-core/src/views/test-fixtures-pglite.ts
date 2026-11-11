/**
 * A PGlite (real Postgres, in-process WASM, no PostGIS) harness for running
 * compiled views. The geometry type is swapped for `text`, so geometry
 * columns hold plain strings here. Test-only; not part of the public entry.
 */
import { PGlite } from "@electric-sql/pglite";

import type { CompiledQuery } from "./types.js";

export async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create table public.entries (
      id uuid primary key default gen_random_uuid(),
      dataset_id uuid not null,
      data jsonb not null
    );
    create table public.geometries (entry_id uuid primary key, geom text);
  `);
  return db;
}

let nextId = 0;

/** Ascending uuids, so "ordered by row_id" is the insertion order in tests. */
function sequentialId(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
}

export async function addRows(
  db: PGlite,
  datasetId: string,
  rows: Record<string, unknown>[],
): Promise<string[]> {
  const ids = rows.map(() => sequentialId());
  await Promise.all(
    rows.map(async (row, i) =>
      db.query("insert into public.entries (id, dataset_id, data) values ($1, $2, $3::jsonb)", [
        ids[i],
        datasetId,
        JSON.stringify(row),
      ]),
    ),
  );
  return ids;
}

/** Unwrap a value the test expects to exist (the lint rules forbid `?.` and `!`). */
export function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

export async function setGeom(db: PGlite, entryId: string, geom: string): Promise<void> {
  await db.query("insert into public.geometries (entry_id, geom) values ($1, $2)", [entryId, geom]);
}

/** Swap the PostGIS geometry type for text so the compiled SQL runs on plain Postgres. */
export function forPglite(sql: string): string {
  return sql.replaceAll("geometry(Geometry,4326)", "text");
}

export async function runQuery<T = Record<string, unknown>>(
  db: PGlite,
  query: CompiledQuery,
): Promise<T[]> {
  const result = await db.query<T>(forPglite(query.sql), query.params);
  return result.rows;
}
