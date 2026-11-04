// Integration tests — §5.1 search_entries semantics against the local
// Supabase Postgres (docs/supabase-migration-design.md §5.1; stage-1 accept:
// "search key validation, keyset pagination stability under inserts").

import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
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

const ROWS = [
  { data: { name: "alpha", count: 1, kind: "a" } },
  { data: { name: "beta", count: 10, kind: "b" } },
  { data: { name: "gamma", count: 2, kind: "a" } },
  { data: { name: "delta", count: 20, kind: "b" } },
  { data: { name: "epsilon", count: 3, kind: "a" } },
];

async function seedDataset(rows: unknown[] = ROWS): Promise<string> {
  const datasetId = await createDataset(s(), {
    createdBy: ALICE,
    properties: ["name", "count", "kind"],
  });
  await s().begin();
  await s().asUser(ALICE);
  await s().expectOk(`select public.import_entries('${datasetId}', ${sqlLit(rows)}::jsonb)`);
  return datasetId;
}

describe.skipIf(!dbUp())("search_entries (§5.1)", () => {
  test("undeclared sort/filter keys, bad ops, bad dirs and bad cursors raise", async () => {
    const datasetId = await seedDataset();
    try {
      expect(
        await s().denied(
          `select * from public.search_entries('${datasetId}', null, null, '{"key":"evil","dir":"asc"}', null, 10)`,
        ),
      ).toMatch(/invalid key/i);
      expect(
        await s().denied(
          `select * from public.search_entries('${datasetId}', null, '[{"key":"name; drop table x","op":"eq","value":1}]', null, null, 10)`,
        ),
      ).toMatch(/invalid key/i);
      expect(
        await s().denied(
          `select * from public.search_entries('${datasetId}', null, '[{"key":"name","op":"SNEAKY","value":1}]', null, null, 10)`,
        ),
      ).toMatch(/invalid op/i);
      expect(
        await s().denied(
          `select * from public.search_entries('${datasetId}', null, null, '{"key":"name","dir":"sideways"}', null, 10)`,
        ),
      ).toMatch(/invalid sort dir/i);
      expect(
        await s().denied(
          `select * from public.search_entries('${datasetId}', null, null, null, 'not-a-cursor', 10)`,
        ),
      ).toMatch(/invalid cursor/i);
      expect(
        await s().count(
          `select count(*) as n from public.entries where dataset_id = '${datasetId}'`,
        ),
      ).toBe(ROWS.length);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("filter ops: eq containment, neq, contains substring, numeric ranges, in", async () => {
    const datasetId = await seedDataset();
    try {
      const names = async (filters: unknown): Promise<string[]> => {
        const rows = await s().expectOk(
          `select data->>'name' as name from public.search_entries('${datasetId}', null, ${sqlLit(filters)}::jsonb, null, null, 50)`,
        );
        return rows.map((r) => r.name as string).toSorted((a, b) => a.localeCompare(b));
      };

      // eq uses jsonb containment (typed, exact).
      expect(await names([{ key: "kind", op: "eq", value: "a" }])).toEqual([
        "alpha",
        "epsilon",
        "gamma",
      ]);
      expect(await names([{ key: "kind", op: "eq", value: "A" }])).toEqual([]);
      // neq is the complement of the containment.
      expect(await names([{ key: "kind", op: "neq", value: "a" }])).toEqual(["beta", "delta"]);
      // contains is a case-insensitive substring over data->>key.
      expect(await names([{ key: "name", op: "contains", value: " gamm " }])).toEqual([]);
      expect(await names([{ key: "name", op: "contains", value: "GAMM" }])).toEqual(["gamma"]);
      // ranges are numeric — 10 sorts past 2, and non-numeric cells never match.
      expect(await names([{ key: "count", op: "gt", value: 2 }])).toEqual([
        "beta",
        "delta",
        "epsilon",
      ]);
      expect(await names([{ key: "count", op: "gte", value: 10 }])).toEqual(["beta", "delta"]);
      expect(await names([{ key: "count", op: "lt", value: 3 }])).toEqual(["alpha", "gamma"]);
      expect(await names([{ key: "count", op: "lte", value: 2 }])).toEqual(["alpha", "gamma"]);
      expect(await names([{ key: "count", op: "gt", value: "not-a-number" }])).toEqual([]);
      // in is exact text membership over data->>key.
      expect(await names([{ key: "name", op: "in", value: ["alpha", "delta"] }])).toEqual([
        "alpha",
        "delta",
      ]);
      // filters compose with AND.
      expect(
        await names([
          { key: "kind", op: "eq", value: "a" },
          { key: "count", op: "gt", value: 1 },
        ]),
      ).toEqual(["epsilon", "gamma"]);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("sort: jsonb ordering keeps numbers numeric and strings lexicographic; default is created_at desc", async () => {
    const datasetId = await seedDataset();
    try {
      const col = async (sort: unknown): Promise<string[]> => {
        const rows = await s().expectOk(
          `select data->>'name' as name from public.search_entries('${datasetId}', null, null, ${sqlLit(sort)}::jsonb, null, 50)`,
        );
        return rows.map((r) => r.name as string);
      };
      // Numbers compare numerically: 1, 2, 3, 10, 20 (not "1","10","2","20","3").
      expect(await col({ key: "count", dir: "asc" })).toEqual([
        "alpha",
        "gamma",
        "epsilon",
        "beta",
        "delta",
      ]);
      expect(await col({ key: "count", dir: "desc" })).toEqual([
        "delta",
        "beta",
        "epsilon",
        "gamma",
        "alpha",
      ]);
      // Strings sort lexicographically.
      expect(await col({ key: "name", dir: "asc" })).toEqual([
        "alpha",
        "beta",
        "delta",
        "epsilon",
        "gamma",
      ]);
      // The default sort is created_at desc (the table default).
      const defaulted = await s().expectOk(
        `select data->>'name' as name from public.search_entries('${datasetId}', null, null, null, null, 50)`,
      );
      expect(defaulted).toHaveLength(ROWS.length);
      // Missing keys: rows without the key come after all valued rows (asc).
      const partial = await seedDataset([
        { data: { name: "withkey", count: 5 } },
        { data: { name: "nokey" } },
      ]);
      const mixed = await s().expectOk(
        `select data->>'name' as name from public.search_entries('${partial}', null, null, '{"key":"count","dir":"asc"}', null, 50)`,
      );
      expect(mixed.map((m) => m.name)).toEqual(["withkey", "nokey"]);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("websearch query filters over the trigger-built vector; '' means no filter", async () => {
    const datasetId = await seedDataset();
    try {
      const rows = await s().expectOk(
        `select data->>'name' as name from public.search_entries('${datasetId}', 'beta', null, null, null, 50)`,
      );
      expect(rows.map((r) => r.name)).toEqual(["beta"]);
      const all = await s().count(
        `select count(*) as n from public.search_entries('${datasetId}', '', null, null, null, 50)`,
      );
      expect(all).toBe(ROWS.length);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("keyset pagination walks every row exactly once and next_cursor nulls at exhaustion", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      data: { name: `row-${String(i).padStart(2, "0")}`, count: (i * 7919) % 25 },
    }));
    const datasetId = await seedDataset(rows);
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await s().expectOk(
          `select id::text as id, data->>'name' as name, next_cursor
           from public.search_entries('${datasetId}', null, null, '{"key":"count","dir":"asc"}',
           ${cursor === null ? "null" : sqlLit(cursor)}, 7)`,
        );
        seen.push(...page.map((r) => r.name as string));
        const first = page[0];
        const next = first === undefined ? null : (first.next_cursor ?? null);
        if (next === null) break;
        cursor = next;
        expect(seen.length).toBeLessThanOrEqual(25);
      }
      // All 25 rows, exactly once, in count order (count = (i*7919)%25 is a
      // permutation of 0..24).
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      const counts = await s().expectOk(
        `select data->>'count' as c, data->>'name' as name from public.entries
         where dataset_id = '${datasetId}'`,
      );
      const byName = new Map(counts.map((c) => [c.name, Number(c.c)]));
      const ordered = seen.map((n) => byName.get(n) as number);
      expect(ordered.toSorted((a, b) => a - b)).toEqual(ordered);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("keyset pagination walks duplicated sort values exactly once (asc ties ride the id-desc tiebreak)", async () => {
    // Three counts x four rows each: every page boundary falls ON duplicate
    // values, which a permutation walk key ((i*7919)%25 — no duplicates) can
    // never exercise. The asc predicate must resolve "strictly after" a tie
    // as id DESC (smaller id), or page 2+ re-returns shown rows and skips
    // their lower-id siblings forever.
    const rows = ["a", "b", "c", "d"].flatMap((suffix) =>
      [1, 2, 3].map((count) => ({ data: { count, name: `${count}-${suffix}` } })),
    );
    const datasetId = await seedDataset(rows);
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = await s().expectOk(
          `select data->>'name' as name, next_cursor from public.search_entries(
             '${datasetId}', null, null, '{"key":"count","dir":"asc"}',
             ${cursor === null ? "null" : sqlLit(cursor)}, 2)`,
        );
        seen.push(...page.map((r) => r.name as string));
        const first = page[0];
        const next = first === undefined ? null : (first.next_cursor ?? null);
        if (next === null) break;
        cursor = next;
        expect(seen.length).toBeLessThanOrEqual(rows.length);
      }
      expect(seen).toHaveLength(rows.length);
      expect(new Set(seen).size).toBe(rows.length);
      // Counts arrive non-decreasing across the whole walk.
      const counts = seen.map((name) => Number(name.split("-")[0]));
      expect(counts.toSorted((a, b) => a - b)).toEqual(counts);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("keyset pagination is stable under concurrent inserts (no duplicates, no skips)", async () => {
    const datasetId = await seedDataset();
    try {
      // Page 1 of the count-asc walk.
      const page1 = await s().expectOk(
        `select data->>'name' as name, next_cursor from public.search_entries(
           '${datasetId}', null, null, '{"key":"count","dir":"asc"}', null, 1)`,
      );
      const cursor = page1[0].next_cursor as string;

      // Rows land mid-walk.
      await s().expectOk(
        `select public.import_entries('${datasetId}', ${sqlLit([
          { data: { name: "mid-a", count: 5 } },
          { data: { name: "mid-b", count: 15 } },
        ])}::jsonb)`,
      );

      const rest: string[] = [];
      let cursor2: string | null = cursor;
      for (;;) {
        const page = await s().expectOk(
          `select data->>'name' as name, next_cursor from public.search_entries(
             '${datasetId}', null, null, '{"key":"count","dir":"asc"}', ${sqlLit(cursor2)}, 2)`,
        );
        rest.push(...page.map((r) => r.name as string));
        const first = page[0];
        const next = first === undefined ? null : (first.next_cursor ?? null);
        if (next === null) break;
        cursor2 = next;
      }
      // The pre-insert row never repeats; the original five appear exactly
      // once each across page1 + the walk.
      const walked = [page1[0].name as string, ...rest];
      expect(new Set(walked).size).toBe(walked.length);
      for (const original of ROWS) {
        expect(walked).toContain(original.data.name);
      }
      expect(walked).toHaveLength(7);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});
