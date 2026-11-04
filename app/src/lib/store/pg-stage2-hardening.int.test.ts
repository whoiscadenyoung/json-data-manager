// Integration tests — stage 2's carry-over hardening (0006): server-side
// p_limit caps, structural page ordering, the datasets-declaration re-index
// trigger, and the owned-key immutability that blocks cross-dataset row
// moves. Same wire-client pattern as the stage-1 pg-*.int.test.ts files
// (admin-created fixtures outside the transaction, role switches inside a
// test-scoped begin/rollback); skips with a one-line message when the stack
// is unreachable.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

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

// A failed test leaves its transaction open (and aborted); roll it back so
// the next test in the file starts from a clean session.
afterEach(async () => {
  if (session) await session.rollbackIfOpen();
});

describe.skipIf(!dbUp())("p_limit caps (0006)", () => {
  test("search_entries caps p_limit server-side at 1000", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["name"],
    });

    await s().begin();
    await s().asUser(ALICE);
    // 1005 rows: a p_limit of 10^7 must still emit ≤ 1000 rows with a cursor.
    await s().expectOk(
      `select public.import_entries(${sqlLit(datasetId)},
        ${sqlLit(
          JSON.stringify(Array.from({ length: 1005 }, (_, i) => ({ data: { name: `row-${i}` } }))),
        )}::jsonb) as n`,
    );
    const rows = await s().expectOk(
      `select id, next_cursor from public.search_entries(${sqlLit(datasetId)}, null, null, null, null, 10000000)`,
    );
    expect(rows.length).toBe(1000);
    expect(rows[0].next_cursor as string).not.toBeNull();

    // The cursor chains: the next page continues where the capped one ended.
    const nextRows = await s().expectOk(
      `select id, next_cursor from public.search_entries(${sqlLit(datasetId)}, null, null, null, ${sqlLit(rows[0].next_cursor)}, 10000000)`,
    );
    expect(nextRows.length).toBe(5);
    expect(nextRows[0].next_cursor as string).toBeNull();
    await s().rollback();

    await dropDatasets(s(), [datasetId]);
  });

  // 0010 (stage-5 carry-over fix) UPDATED this pin: 0006 clamped
  // dataset_rows_for_tiles to 1000, contradicting its own §5.5 signature
  // default (5000) and the callers' requested widths (the row seam's 2000,
  // the worker's 5000); the cap now IS the §5.5 default, so a 1005-row
  // fixture with p_limit = 10^7 answers ALL 1005 rows in one uncapped page
  // — the exact 5000 clamp is pinned by pg-stage5-derived.int.test.ts's
  // 5201-row fixture.
  test("dataset_rows_for_tiles clamps p_limit at the §5.5 default (5000), no longer 0006's 1000", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["name"],
    });

    await s().begin();
    await s().asUser(ALICE);
    await s().expectOk(
      `select public.import_entries(${sqlLit(datasetId)},
        ${sqlLit(
          JSON.stringify(
            Array.from({ length: 1005 }, (_, i) => ({
              data: { name: `row-${i}` },
              geometry: { type: "Point", coordinates: [i, i] },
            })),
          ),
        )}::jsonb) as n`,
    );
    const rows = await s().expectOk(
      `select entry_id, next_cursor from public.dataset_rows_for_tiles(${sqlLit(datasetId)}, null, 10000000)`,
    );
    expect(rows.length).toBe(1005);
    expect(rows[0].next_cursor as string).toBeNull();

    // The hardening's real point still holds: an absurd page width cannot
    // materialize beyond the cap — exercised at exact scale by
    // pg-stage5-derived.int.test.ts ("clamps p_limit = 10^7 ...").
    const nextRows = await s().expectOk(
      `select entry_id, next_cursor from public.dataset_rows_for_tiles(${sqlLit(datasetId)}, null, 5000)`,
    );
    expect(nextRows.length).toBe(1005);
    expect(nextRows[0].next_cursor as string).toBeNull();
    await s().rollback();

    await dropDatasets(s(), [datasetId]);
  });
});

describe.skipIf(!dbUp())("structural page ordering (0006)", () => {
  test("a sorted page comes back in (key, id desc) order, cursored exactly", async () => {
    const datasetId = await createDataset(s(), {
      createdBy: ALICE,
      properties: ["v"],
    });

    await s().begin();
    await s().asUser(ALICE);
    // Duplicate sort values exercise the id-desc tiebreak through aggregation.
    await s().expectOk(
      `select public.import_entries(${sqlLit(datasetId)},
        ${sqlLit(
          JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ data: { v: i % 5 } }))),
        )}::jsonb) as n`,
    );
    const page1 = await s().expectOk(
      `select id, data, next_cursor from public.search_entries(${sqlLit(datasetId)}, null, null, '{"key":"v","dir":"asc"}'::jsonb, null, 17)`,
    );
    expect(page1.length).toBe(17);
    const vals = page1.map((r) => (JSON.parse(r.data ?? "{}") as { v: number }).v);
    expect(vals).toEqual(vals.toSorted((a, b) => a - b));
    // Same-value neighbors: ids strictly descending (the tiebreak — uuids
    // order byte-wise, and the lowercase dashed text form orders the same).
    const idsDescendingWithinEqual = page1.every((r, i) => {
      if (i === 0 || vals[i] !== vals[i - 1]) return true;
      return (r.id as string) < (page1[i - 1].id as string);
    });
    expect(idsDescendingWithinEqual).toBe(true);

    // Chained page 2 is strictly after page 1: no repeats, sorted again.
    const page2 = await s().expectOk(
      `select id, data, next_cursor from public.search_entries(${sqlLit(datasetId)}, null, null, '{"key":"v","dir":"asc"}'::jsonb, ${sqlLit(page1[16].next_cursor)}, 17)`,
    );
    const seen = new Set(page1.map((r) => r.id));
    expect(page2.filter((r) => seen.has(r.id)).length).toBe(0);
    const vals2 = page2.map((r) => (JSON.parse(r.data ?? "{}") as { v: number }).v);
    expect(vals2).toEqual(vals2.toSorted((a, b) => a - b));
    await s().rollback();

    await dropDatasets(s(), [datasetId]);
  });
});

describe.skipIf(!dbUp())("declaration re-index trigger (0006)", () => {
  test("a newly declared search key finds pre-existing rows", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE, properties: ["name"] });
    const entryId = await addEntry(s(), datasetId, { name: "alpha", note: "wombat-unique" });

    await s().begin();
    await s().asUser(ALICE);
    // Before the declaration changes, note: is not searchable.
    expect(
      await s().count(
        `select count(*) as n from public.search_entries(${sqlLit(datasetId)}, 'wombat-unique')`,
      ),
    ).toBe(0);

    // Declare note: the trigger re-indexes the dataset's existing rows.
    await s().expectOk(
      `update public.datasets set properties = ${sqlLit(JSON.stringify(["name", "note"]))}::jsonb where id = ${sqlLit(datasetId)}`,
    );
    const found = await s().expectOk(
      `select id from public.search_entries(${sqlLit(datasetId)}, 'wombat-unique')`,
    );
    expect(found.map((r) => r.id)).toContain(entryId);

    // An unchanged-declaration write does NOT re-index (the guard): blank the
    // vector directly, touch only title, and confirm the vector is left alone.
    await s().expectOk(
      `update public.entries set search = ''::tsvector where id = ${sqlLit(entryId)}`,
    );
    await s().expectOk(
      `update public.datasets set title = 'pg-int fixture' where id = ${sqlLit(datasetId)}`,
    );
    expect(
      await s().count(
        `select count(*) as n from public.search_entries(${sqlLit(datasetId)}, 'wombat-unique')`,
      ),
    ).toBe(0);
    await s().rollback();

    await dropDatasets(s(), [datasetId]);
  });

  test("a newly declared x-reference field re-derives references on existing rows", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE, properties: ["name"] });
    await addEntry(s(), datasetId, { name: "target" });
    const sourceId = await addEntry(s(), datasetId, { name: "source" });

    await s().begin();
    await s().asUser(ALICE);
    // Declare name as a one-cardinality reference field: the re-index rides
    // the entries write and re-derives entry_references from the new
    // json_schema.
    await s().expectOk(
      `update public.datasets set json_schema = ${sqlLit(
        JSON.stringify({
          properties: { name: { type: "string", "x-reference": { cardinality: "one" } } },
        }),
      )}::jsonb where id = ${sqlLit(datasetId)}`,
    );
    // Both rows carry string names; only values naming an existing entry id
    // become rows — neither name does, so the re-derivation adds none.
    expect(
      await s().count(
        `select count(*) as n from public.entry_references where source_dataset_id = ${sqlLit(datasetId)}`,
      ),
    ).toBe(0);

    // Point one name at a real entry id; the entry write re-derives one row.
    const targetRows = await s().expectOk(
      `select id::text as id from public.entries where dataset_id = ${sqlLit(datasetId)} and data ->> 'name' = 'target'`,
    );
    const targetId = targetRows[0].id as string;
    await s().expectOk(
      `update public.entries set data = jsonb_set(data, '{name}', to_jsonb(${sqlLit(targetId)}::text)) where id = ${sqlLit(sourceId)}`,
    );
    expect(
      await s().count(
        `select count(*) as n from public.entry_references where source_entry_id = ${sqlLit(sourceId)}`,
      ),
    ).toBe(1);
    await s().rollback();

    await dropDatasets(s(), [datasetId]);
  });
});

describe.skipIf(!dbUp())("owned-key immutability (0006)", () => {
  test("entries.dataset_id cannot change, even to another editable dataset", async () => {
    const datasetA = await createDataset(s(), { createdBy: ALICE });
    const datasetB = await createDataset(s(), { createdBy: ALICE });
    const entryId = await addEntry(s(), datasetA, { name: "movable" });

    await s().begin();
    await s().asUser(ALICE);
    // Both datasets are ALICE's and open: both RLS sides pass — the trigger
    // is what refuses.
    await expect(
      s().denied(
        `update public.entries set dataset_id = ${sqlLit(datasetB)} where id = ${sqlLit(entryId)}`,
      ),
    ).resolves.toMatch(/immutable/i);
    // Count integrity: the move (had it happened) would have left A's
    // summary stale; nothing changed.
    expect(
      await s().count(
        `select entry_count as n from public.datasets where id = ${sqlLit(datasetA)}`,
      ),
    ).toBe(1);
    await s().rollback();

    await dropDatasets(s(), [datasetA, datasetB]);
  });

  test("geometries.dataset_id / geometries.entry_id cannot change", async () => {
    const datasetA = await createDataset(s(), { createdBy: ALICE });
    const datasetB = await createDataset(s(), { createdBy: ALICE });
    const e1 = await addEntry(s(), datasetA, { name: "a" });
    const e2 = await addEntry(s(), datasetA, { name: "b" });
    await s().expectOk(
      `insert into public.geometries (dataset_id, entry_id, source, type)
       values (${sqlLit(datasetA)}, ${sqlLit(e1)}, '{"type":"Point","coordinates":[1,2]}'::jsonb, 'Point')`,
    );
    const geomRows = await s().expectOk(
      `select id::text as id from public.geometries where dataset_id = ${sqlLit(datasetA)}`,
    );
    const geomId = geomRows[0].id as string;

    await s().begin();
    await s().asUser(ALICE);
    await expect(
      s().denied(
        `update public.geometries set dataset_id = ${sqlLit(datasetB)} where id = ${sqlLit(geomId)}`,
      ),
    ).resolves.toMatch(/immutable/i);
    await expect(
      s().denied(
        `update public.geometries set entry_id = ${sqlLit(e2)} where id = ${sqlLit(geomId)}`,
      ),
    ).resolves.toMatch(/immutable/i);
    await s().rollback();

    await dropDatasets(s(), [datasetA, datasetB]);
  });

  test("same-value updates still pass (immutability is value-based, not column-based)", async () => {
    const datasetA = await createDataset(s(), { createdBy: ALICE });
    const entryId = await addEntry(s(), datasetA, { name: "steady" });

    await s().begin();
    await s().asUser(ALICE);
    await s().expectOk(
      `update public.entries set data = '{"name":"steady"}'::jsonb, dataset_id = ${sqlLit(datasetA)} where id = ${sqlLit(entryId)}`,
    );
    // The same-value write landed and the row did not move.
    expect(
      await s().count(
        `select count(*) as n from public.entries where id = ${sqlLit(entryId)} and dataset_id = ${sqlLit(datasetA)}`,
      ),
    ).toBe(1);
    await s().rollback();

    await dropDatasets(s(), [datasetA]);
  });
});
