// Integration tests — entry_references derivation trigger round-trip
// (docs/supabase-migration-design.md §3.2 entry_references; stage-1 accept:
// "the reference-trigger round-trip"). The trigger re-derives from the
// x-reference fields the dataset's json_schema declares — the same detection
// as packages/data-core/src/reference.ts getReferenceFields/extractReferenceIds.

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
  addEntry,
  ALICE,
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

describe.skipIf(!dbUp())("entry_references derivation (§3.2)", () => {
  test("declared one/many fields derive rows; undeclared fields and non-entry strings do not", async () => {
    const sourceId = await createDataset(s(), { createdBy: ALICE, properties: ["name"] });
    const targetId = await createDataset(s(), { createdBy: ALICE, properties: ["label"] });
    try {
      await s().begin();
      await s().asUser(ALICE);
      const t1 = await addEntry(s(), targetId, { label: "target-1" });
      const t2 = await addEntry(s(), targetId, { label: "target-2" });

      await s().expectOk(
        `update public.datasets set json_schema = ${sqlLit({
          properties: {
            targetRef: {
              type: "string",
              "x-reference": { datasetId: targetId, cardinality: "one" },
            },
            targets: { type: "array", "x-reference": { datasetId: targetId, cardinality: "many" } },
            junk: { type: "string" },
          },
        })}::jsonb where id = '${sourceId}'`,
      );

      const sourceEntryId = await addEntry(s(), sourceId, {
        name: "ref-row",
        // 'one': a real id -> one row. 'many': t1 twice (deduped), t2,
        // a uuid-shaped string naming no entry, a number and junk — only
        // existing entry ids count. 'junk' is NOT a declared reference
        // field: its entry-id value derives nothing.
        targetRef: t1,
        targets: [t1, t1, t2, "00000000-0000-4000-8000-ffffffffffff", 42, "not-an-id-at-all"],
        junk: t2,
      });

      const refs = await s().expectOk(
        `select field_name, target_entry_id, source_dataset_id, target_dataset_id
         from public.entry_references where source_entry_id = '${sourceEntryId}'
         order by field_name, target_entry_id`,
      );
      expect(
        refs
          .map((r) => `${r.field_name}:${r.target_entry_id === t1 ? "t1" : "t2"}`)
          .toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["targetRef:t1", "targets:t1", "targets:t2"]);
      expect(refs.every((r) => r.source_dataset_id === sourceId)).toBe(true);
      expect(refs.every((r) => r.target_dataset_id === targetId)).toBe(true);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [sourceId, targetId]);
    }
  });

  test("updating data re-derives (delete-and-rederive), non-string values never qualify", async () => {
    const sourceId = await createDataset(s(), { createdBy: ALICE, properties: ["name"] });
    const targetId = await createDataset(s(), { createdBy: ALICE, properties: ["label"] });
    try {
      await s().begin();
      await s().asUser(ALICE);
      const t1 = await addEntry(s(), targetId, { label: "target-1" });
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
      const sourceEntryId = await addEntry(s(), sourceId, { name: "r", targetRef: t1 });
      expect(
        await s().count(
          `select count(*) as n from public.entry_references where source_entry_id = '${sourceEntryId}'`,
        ),
      ).toBe(1);

      // Point the field at a new entry: the old row is gone.
      const t2 = await addEntry(s(), targetId, { label: "target-2" });
      await s().expectOk(
        `update public.entries set data = data || ${sqlLit(JSON.stringify({ targetRef: t2 }))}::jsonb
         where id = '${sourceEntryId}'`,
      );
      const refs = await s().expectOk(
        `select target_entry_id from public.entry_references where source_entry_id = '${sourceEntryId}'`,
      );
      expect(refs.map((r) => r.target_entry_id)).toEqual([t2]);

      // A number in the field (not a string) derives nothing.
      await s().expectOk(
        `update public.entries set data = jsonb_set(data, '{targetRef}', '42') where id = '${sourceEntryId}'`,
      );
      expect(
        await s().count(
          `select count(*) as n from public.entry_references where source_entry_id = '${sourceEntryId}'`,
        ),
      ).toBe(0);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [sourceId, targetId]);
    }
  });

  test("deleting a source or target entry removes its reference rows", async () => {
    const sourceId = await createDataset(s(), { createdBy: ALICE, properties: ["name"] });
    const targetId = await createDataset(s(), { createdBy: ALICE, properties: ["label"] });
    try {
      await s().begin();
      await s().asUser(ALICE);
      const t1 = await addEntry(s(), targetId, { label: "target-1" });
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
      const s1 = await addEntry(s(), sourceId, { name: "r1", targetRef: t1 });
      const s2 = await addEntry(s(), sourceId, { name: "r2", targetRef: t1 });
      expect(
        await s().count(`select count(*) as n from public.entry_references`),
      ).toBeGreaterThanOrEqual(2);

      // Delete one source entry: its derived rows go with it.
      await s().expectOk(`delete from public.entries where id = '${s1}'`);
      const afterSource = await s().expectOk(`select source_entry_id from public.entry_references`);
      expect(afterSource.map((r) => r.source_entry_id)).toEqual([s2]);

      // Delete the TARGET entry: target-side cascade clears the rest.
      await s().expectOk(`delete from public.entries where id = '${t1}'`);
      expect(await s().count(`select count(*) as n from public.entry_references`)).toBe(0);

      await s().rollback();
    } finally {
      await dropDatasets(s(), [sourceId, targetId]);
    }
  });
});
