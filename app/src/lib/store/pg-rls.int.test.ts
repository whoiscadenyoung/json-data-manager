// Integration tests — §4 RLS matrix against the local Supabase Postgres
// (docs/supabase-migration-design.md §4, §15.4; stage-1 accept: "RLS (anon
// denied; collaborator open-edit; locked creator-only; frozen read-only)").
//
// The tests speak SQL directly and switch roles per transaction
// (`set local role authenticated` + the request.jwt.claims GUC that
// auth.uid() reads), exercising the same RLS the PostgREST path does
// without needing a running GoTrue. Works against CI's service container
// (SUPABASE_DB_URL) and the local stack unchanged.

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
  addEntry,
  ALICE,
  BOB,
  createDataset,
  DB_URL,
  dbUp,
  dropDatasets,
  ensureUsers,
  PgSession,
  sqlLit,
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
    await ensureUsers(session);
  }
});

afterAll(async () => {
  if (session) await session.close();
  session = undefined;
});

describe.skipIf(!dbUp())("RLS matrix (§4)", () => {
  test("anon is denied reads and writes on all four tables", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    await addEntry(s(), datasetId, { name: "row" });
    try {
      await s().begin();
      await s().asAnon();

      // Reads: RLS filters everything (no error, zero rows).
      expect(await s().count("select count(*) as n from public.datasets")).toBe(0);
      expect(await s().count("select count(*) as n from public.entries")).toBe(0);
      expect(await s().count("select count(*) as n from public.geometries")).toBe(0);
      expect(await s().count("select count(*) as n from public.imports")).toBe(0);
      expect(await s().count("select count(*) as n from public.entry_references")).toBe(0);

      // Writes: INSERTs raise a policy violation; UPDATE/DELETE take the
      // "reads as not found" shape (0 rows affected).
      await expect(
        s().denied(
          `insert into public.entries (dataset_id, data) values ('${datasetId}', '{"name":"anon"}'::jsonb)`,
        ),
      ).resolves.toMatch(/row-level security/i);
      await expect(
        s().denied(`update public.datasets set title = 'anon' where id = '${datasetId}'`),
      ).resolves.toMatch(/0 rows affected/);
      await expect(
        s().denied(`delete from public.entries where dataset_id = '${datasetId}'`),
      ).resolves.toMatch(/0 rows affected/);
      await expect(
        s().denied(
          `select * from public.search_entries('${datasetId}', null, null, null, null, 10)`,
        ),
      ).resolves.toMatch(/not found or not visible/i);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("collaborator co-edits an open dataset but cannot flip its edit policy", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await s().begin();
      await s().asUser(BOB);

      // Open dataset: readable AND writable by a second signed-in user
      // (ADR 0009 trusted collaborator).
      expect(
        await s().count(`select count(*) as n from public.datasets where id = '${datasetId}'`),
      ).toBe(1);
      await s().expectOk(
        `insert into public.entries (dataset_id, data) values ('${datasetId}', '{"name":"bob"}'::jsonb)`,
      );
      expect(
        await s().count(
          `select count(*) as n from public.entries where dataset_id = '${datasetId}'`,
        ),
      ).toBe(1);

      // Flipping edit_policy is itself a gated write (the setEditPolicy
      // rule: creator-only either way — the restrictive policy raises for
      // a non-creator even on an open dataset).
      expect(
        await s().denied(
          `update public.datasets set edit_policy = 'locked' where id = '${datasetId}'`,
        ),
      ).toMatch(/row-level security/i);
      expect(
        await s().expectOk(`select edit_policy from public.datasets where id = '${datasetId}'`),
      ).toEqual([{ edit_policy: "open" }]);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("locked dataset is creator-only for writes, readable by everyone", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });
    try {
      await s().begin();
      await s().asUser(BOB);
      expect(
        await s().count(`select count(*) as n from public.datasets where id = '${datasetId}'`),
      ).toBe(1);
      expect(
        await s().denied(
          `insert into public.entries (dataset_id, data) values ('${datasetId}', '{"name":"bob"}'::jsonb)`,
        ),
      ).toMatch(/row-level security/i);
      expect(await s().denied(`delete from public.datasets where id = '${datasetId}'`)).toMatch(
        /0 rows affected/,
      );
      // RPC writes are RLS-gated too (import_entries is SECURITY INVOKER).
      expect(
        await s().denied(
          `select * from public.import_entries('${datasetId}', '[{"data":{"name":"x"}}]'::jsonb)`,
        ),
      ).toMatch(/row-level security/i);

      // The creator writes their own locked dataset (ADR 0010, no carve-outs).
      await s().asUser(ALICE);
      await s().expectOk(
        `insert into public.entries (dataset_id, data) values ('${datasetId}', '{"name":"alice"}'::jsonb)`,
      );
      expect(
        await s().count(
          `select count(*) as n from public.entries where dataset_id = '${datasetId}'`,
        ),
      ).toBe(1);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("a frozen (lineage not null) dataset is read-only for everyone, creator included", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE, frozenLineage: true });
    try {
      await s().begin();
      await s().asUser(ALICE);
      expect(
        await s().denied(
          `insert into public.entries (dataset_id, data) values ('${datasetId}', '{"name":"alice"}'::jsonb)`,
        ),
      ).toMatch(/row-level security/i);
      // The absolute read-only guarantee (ADR 0009): even the creator's
      // own UPDATE reads as not-found.
      expect(
        await s().denied(`update public.datasets set title = 'no' where id = '${datasetId}'`),
      ).toMatch(/0 rows affected/);

      await s().asUser(BOB);
      expect(
        await s().denied(
          `insert into public.entries (dataset_id, data) values ('${datasetId}', '{"name":"bob"}'::jsonb)`,
        ),
      ).toMatch(/row-level security/i);
      // Reads stay open per the dataset's visibility (published/everyone).
      expect(
        await s().count(`select count(*) as n from public.datasets where id = '${datasetId}'`),
      ).toBe(1);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("drafts are invisible to non-creators; author-visibility restricts reads", async () => {
    const draftId = await createDataset(s(), { createdBy: ALICE, lifecycle: "draft" });
    const authorId = await createDataset(s(), { createdBy: ALICE, visibility: "author" });
    try {
      await s().begin();
      await s().asAdmin();
      await s().expectOk(
        `insert into public.entries (dataset_id, data) values ('${draftId}', '{"name":"x"}'::jsonb)`,
      );
      await s().asUser(BOB);
      expect(
        await s().count(`select count(*) as n from public.datasets where id = '${draftId}'`),
      ).toBe(0);
      expect(
        await s().count(`select count(*) as n from public.datasets where id = '${authorId}'`),
      ).toBe(0);
      // Their entries are invisible with them (entries SELECT rides
      // can_view_dataset(dataset_id)).
      expect(
        await s().count(`select count(*) as n from public.entries where dataset_id = '${draftId}'`),
      ).toBe(0);

      // The creator sees both.
      await s().asUser(ALICE);
      expect(
        await s().count(`select count(*) as n from public.datasets where id = '${draftId}'`),
      ).toBe(1);
      expect(
        await s().count(`select count(*) as n from public.datasets where id = '${authorId}'`),
      ).toBe(1);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [draftId, authorId]);
    }
  });

  test("entry_references are visible when either side is, and writable only by the trigger", async () => {
    const sourceId = await createDataset(s(), { createdBy: ALICE });
    const targetId = await createDataset(s(), { createdBy: ALICE });
    const targetEntryId = await addEntry(s(), targetId, { name: "target" });
    try {
      await s().begin();
      await s().asAdmin();
      // Declare a reference field and write a source entry pointing at the
      // target; the trigger derives the row (SECURITY DEFINER).
      await s().expectOk(
        `update public.datasets set json_schema = ${sqlLit({
          properties: {
            targetRef: {
              type: "string",
              "x-reference": { datasetId: targetId, cardinality: "one" },
            },
          },
        })}::jsonb where id = '${sourceId}'`,
      );
      await addEntry(s(), sourceId, { name: "source", targetRef: targetEntryId });

      await s().asUser(BOB);
      // Both sides viewable by any authenticated user -> row visible.
      expect(
        await s().count(
          `select count(*) as n from public.entry_references where source_dataset_id = '${sourceId}'`,
        ),
      ).toBe(1);
      // No write policies: direct writes are denied even for editors
      // (DELETE filters to nothing; INSERT raises).
      expect(
        await s().denied(
          `delete from public.entry_references where source_dataset_id = '${sourceId}'`,
        ),
      ).toMatch(/0 rows affected/);
      expect(
        await s().denied(
          `insert into public.entry_references
             (source_entry_id, source_dataset_id, target_entry_id, target_dataset_id, field_name)
           values ('${targetEntryId}', '${sourceId}', '${targetEntryId}', '${targetId}', 'targetRef')`,
        ),
      ).toMatch(/row-level security/i);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [sourceId, targetId]);
    }
  });
});
