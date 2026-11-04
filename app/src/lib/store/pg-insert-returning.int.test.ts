// Integration regression test — INSERT .. RETURNING must pass the SELECT
// policy on the new row (migration 0008_insert_returning_visibility.sql).
//
// The shipped dataset-create path is supabase-js `.insert(...).select("id")`:
// an INSERT with a RETURNING clause. Postgres evaluates the SELECT policy on
// the new row to decide what RETURNING may hand back, and the definer
// visibility helpers read the table with the statement's snapshot — where the
// just-inserted row is not yet visible — so the policies answered false on
// the very row the invoker had just written (42501) and every real create
// failed. Found by the live 20k A/B verification (2026-11-04), not by this
// suite: the fixtures create rows via direct superuser SQL, which never
// exercises the PostgREST create path. This test drives the failing shape
// directly, in the same role/GUC switch the other RLS tests use.
//
// Works against CI's service container (SUPABASE_DB_URL) and the local stack
// unchanged; skips with a one-line reason when neither is reachable.

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  createDataset,
  DB_URL,
  dbUp,
  dropDatasets,
  PgSession,
} from "./pg-int-helpers.int.test";

let session: PgSession | undefined;

/** The per-file session (connected in beforeEach when the stack is up). */
function s(): PgSession {
  if (session === undefined) throw new Error("integration session not connected");
  return session;
}

beforeEach(async () => {
  if (dbUp() && !session) {
    session = await PgSession.connect(DB_URL);
  }
});

afterAll(async () => {
  if (session) await session.close();
  session = undefined;
});

describe.skipIf(!dbUp())("INSERT .. RETURNING passes the SELECT policy (0008)", () => {
  test("datasets: the shipped .insert().select('id') create shape returns the row", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await s().begin();
      await s().asUser(ALICE);
      const result = await s().query(
        `insert into public.datasets (title, json_schema, properties, is_geospatial)
         values ('returning-regression', '{"type":"object","properties":{"name":{"type":"string"}}}'::jsonb, '["name"]'::jsonb, true)
         returning id;`,
      );
      // Before 0008 this raised 42501 "new row violates row-level security
      // policy" — the SELECT policy on the new row answered false.
      expect(result.error).toBeUndefined();
      const row = result.rows.at(-1);
      expect(row !== undefined && typeof row.id === "string").toBe(true);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("entries: insert with returning id as the dataset creator returns the row", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await s().begin();
      await s().asUser(ALICE);
      const result = await s().query(
        `insert into public.entries (dataset_id, data)
         values ('${datasetId}', '{"name":"row-1"}'::jsonb)
         returning id;`,
      );
      expect(result.error).toBeUndefined();
      const row = result.rows.at(-1);
      expect(row !== undefined && typeof row.id === "string").toBe(true);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});
