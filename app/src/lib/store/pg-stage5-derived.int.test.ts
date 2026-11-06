// Integration tests — stage 5's derived-datasets registry
// (docs/supabase-migration-design.md §3.5/§4/§13 "Stage 5"; issue #204's
// acceptance criteria) against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), every statement awaited (the
// single-pipelining lesson), everything rolled back at the end. Works against
// CI's service container (SUPABASE_DB_URL) and the local stack unchanged.
// Skips with a one-line message when the stack is unreachable.
//
// The registry TABLE landed in stage 4 (migration 0009); stage 5's migration
// (0010) tightens its RLS to the Convex registry rules and realigns the
// dataset_rows_for_tiles cap — so the coverage here is:
//   * the 0010 RLS matrix: saved catalog-visible / drafts creator-private /
//     creator-only update+delete / created_by theft blocked / anon denied;
//   * the 0008-shape INSERT .. RETURNING test for the table the UI writes
//     with .select() (the builder autosave's read-back);
//   * attribution stamping (identity from the session, never the payload);
//   * the DDL's shape guards (status check, num_nonnulls, source FKs) —
//     the FKs are what make save()'s unknown-source refusal real;
//   * the Convex-mirroring indexes (derived_by_status_source /
//     derived_by_source_creator);
//   * the 0010 cap realignment: p_limit = 2000 (the row seam's width) is
//     honored, p_limit = 10^7 clamps to the §5.5 default 5000, and the bare
//     default matches the signature.
//
// Cycle rejection is STORE-side (store/derived.ts walks depends_on like the
// Convex findCycleToOrigin) — covered by derived.test.ts's stub-client tests,
// not here.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
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

/** The first element, or a loud failure (the no-optional-chaining test style). */
function firstRow(
  rows: ReadonlyArray<Record<string, string | null>>,
): Record<string, string | null> {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected at least one row (have ${rows.length}).`);
  }
  return row;
}

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

async function beginAs(userId: string): Promise<void> {
  await s().begin();
  await s().asUser(userId);
}

/** The CommandComplete tag without its wire NUL terminator ("UPDATE 0\0" → "UPDATE 0"). */
function tagOf(tag: string | undefined): string {
  return (tag ?? "").replaceAll("\0", "");
}

/**
 * Savepoint-wrapped statement expected to RAISE (a constraint, an FK, an RLS
 * with-check). Returns the error message for matching; throws when it
 * succeeded.
 */
async function expectRaises(text: string): Promise<string> {
  const sp = `sp_${crypto.randomUUID().replaceAll("-", "")}`;
  await s().expectOk(`savepoint ${sp}`);
  const result = await s().query(text);
  await s().expectOk(`rollback to ${sp}`);
  await s().expectOk(`release ${sp}`);
  if (result.error !== undefined) {
    return result.error;
  }
  throw new Error(`expected the statement to raise, but it succeeded: ${text}`);
}

/** One registry row as the CURRENT user (the stamp trigger attributes it); returns the id. */
async function createDerived(opts: {
  datasetId: string;
  status: "draft" | "saved";
  title?: string;
  spec?: unknown;
}): Promise<string> {
  const spec =
    opts.spec === undefined ? { operations: [], sourceDatasetId: opts.datasetId } : opts.spec;
  const rows = await s().expectOk(
    `insert into public.derived_datasets (title, spec, source_dataset_id, status)
     values (${sqlLit(opts.title ?? "stage-5 fixture")}, ${sqlLit(JSON.stringify(spec))}::jsonb, ${sqlLit(opts.datasetId)}, ${sqlLit(opts.status)})
     returning id::text as id`,
  );
  return firstRow(rows).id as string;
}

/** A dataset with `count` point-geometry entries, bulk-inserted (the cap tests' fixture). */
async function createGeospatialDatasetWithRows(count: number): Promise<string> {
  const datasetId = await createDataset(s(), {
    createdBy: ALICE,
    properties: ["name"],
  });
  await s().expectOk(
    `insert into public.entries (dataset_id, data)
     select ${sqlLit(datasetId)}, ('{"name": "row ' || g || '"}')::jsonb
     from generate_series(1, ${count}) g`,
  );
  await s().expectOk(
    `insert into public.geometries (dataset_id, entry_id, source, type, created_by)
     select ${sqlLit(datasetId)}, e.id, '{"type": "Point", "coordinates": [1.0, 2.0]}'::jsonb, 'Point', ${sqlLit(ALICE)}
     from public.entries e
     where e.dataset_id = ${sqlLit(datasetId)}`,
  );
  return datasetId;
}

/** The page width + the page's (uniform) next_cursor of one dataset_rows_for_tiles call. */
async function pageOf(
  datasetId: string,
  cursor: string | null,
  limit: number | null,
): Promise<{ count: number; hasNext: boolean; nextCursor: string | null }> {
  const rows = await s().expectOk(
    `select count(*) as n, bool_or(next_cursor is not null) as has_more,
            (array_agg(next_cursor order by entry_id desc))[1] as last_cursor
     from public.dataset_rows_for_tiles(
       ${sqlLit(datasetId)},
       ${cursor === null ? "null" : sqlLit(cursor)},
       ${limit === null ? "null" : String(limit)}
     )`,
  );
  const row = firstRow(rows);
  return {
    count: Number(row.n),
    hasNext: row.has_more === "t",
    nextCursor: row.last_cursor,
  };
}

describe.skipIf(!dbUp())(
  "stage 5 — derived_datasets RLS (0010 — the Convex registry rules)",
  () => {
    test("the 0008 RETURNING shape: a draft insert .. returning hands the caller its own row", async () => {
      const datasetId = await createDataset(s(), { createdBy: ALICE });
      try {
        await beginAs(ALICE);
        // The builder autosave's write path: INSERT with a read-back (PostgREST
        // `.select()`). 0008's lesson — the SELECT policy is evaluated on the
        // just-inserted row; the 0010 policy passes it because the row is born
        // with created_by = auth.uid().
        const rows = await s().expectOk(
          `insert into public.derived_datasets (title, spec, source_dataset_id, status)
         values ('autosaved draft', ${sqlLit(JSON.stringify({ operations: [], sourceDatasetId: datasetId }))}::jsonb, ${sqlLit(datasetId)}, 'draft')
         returning id::text as id, title, status, created_by::text as created_by`,
        );
        const row = firstRow(rows);
        expect(row.title).toBe("autosaved draft");
        expect(row.status).toBe("draft");
        expect(row.created_by).toBe(ALICE);
        await s().rollback();
      } finally {
        await dropDatasets(s(), [datasetId]);
      }
    });

    test("attribution is stamped from the session, never claimed from the payload", async () => {
      const datasetId = await createDataset(s(), { createdBy: ALICE });
      try {
        await beginAs(ALICE);
        // created_by rides the request identity: the 0009 stamp trigger
        // overwrites whatever the payload claimed.
        const rows = await s().expectOk(
          `insert into public.derived_datasets (title, spec, source_dataset_id, status, created_by)
         values ('spoofed', ${sqlLit(JSON.stringify({ operations: [], sourceDatasetId: datasetId }))}::jsonb, ${sqlLit(datasetId)}, 'saved', ${sqlLit(BOB)})
         returning id::text as id, created_by::text as created_by`,
        );
        expect(firstRow(rows).created_by).toBe(ALICE);
        await s().rollback();
      } finally {
        await dropDatasets(s(), [datasetId]);
      }
    });

    test("saved rows are catalog-visible; foreign drafts are invisible; the creator sees their draft", async () => {
      const datasetId = await createDataset(s(), { createdBy: ALICE });
      try {
        await beginAs(ALICE);
        const savedId = await createDerived({ datasetId, status: "saved", title: "saved spec" });
        const draftId = await createDerived({
          datasetId,
          status: "draft",
          title: "draft autosave",
        });

        await s().asUser(BOB);
        // BOB: the saved row is the registry's published side; ALICE's draft
        // reads exactly as a missing row (the stage-8 split, now as RLS).
        const bobRows = await s().expectOk(
          `select id::text as id, status from public.derived_datasets where id::text in (${sqlLit(savedId)}, ${sqlLit(draftId)})`,
        );
        expect(bobRows.length).toBe(1);
        expect(firstRow(bobRows).id).toBe(savedId);
        const bobDraft = await s().expectOk(
          `select id::text as id from public.derived_datasets where id::text = ${sqlLit(draftId)}`,
        );
        expect(bobDraft.length).toBe(0);

        await s().asUser(ALICE);
        // ALICE: both of her rows.
        const aliceRows = await s().expectOk(
          `select id::text as id from public.derived_datasets where id::text in (${sqlLit(savedId)}, ${sqlLit(draftId)})`,
        );
        expect(aliceRows.length).toBe(2);
        await s().rollback();
      } finally {
        await dropDatasets(s(), [datasetId]);
      }
    });

    test("updates and deletes answer to the creator alone — and created_by cannot be re-taken", async () => {
      const datasetId = await createDataset(s(), { createdBy: ALICE });
      try {
        await beginAs(ALICE);
        const savedId = await createDerived({ datasetId, status: "saved" });
        const draftId = await createDerived({ datasetId, status: "draft" });

        await s().asUser(BOB);
        // BOB cannot update ALICE's rows (using-arm deny: 0 rows — the
        // "reads as not found" denial shape), including by RE-TAKING
        // created_by (the 0009 using(true) hole this policy closes).
        const foreignUpdate = await s().query(
          `update public.derived_datasets set title = 'stolen' where id::text = ${sqlLit(savedId)}`,
        );
        expect(foreignUpdate.error).toBeUndefined();
        expect(tagOf(foreignUpdate.tag)).toBe("UPDATE 0");
        const theft = await s().query(
          `update public.derived_datasets set created_by = ${sqlLit(BOB)}::uuid where id::text = ${sqlLit(savedId)}`,
        );
        expect(theft.error).toBeUndefined();
        expect(tagOf(theft.tag)).toBe("UPDATE 0");
        const foreignDelete = await s().query(
          `delete from public.derived_datasets where id::text = ${sqlLit(draftId)}`,
        );
        expect(foreignDelete.error).toBeUndefined();
        expect(tagOf(foreignDelete.tag)).toBe("DELETE 0");

        await s().asUser(ALICE);
        // The creator promotes her draft and retitles her saved row.
        const promote = await s().query(
          `update public.derived_datasets set status = 'saved' where id::text = ${sqlLit(draftId)}`,
        );
        expect(promote.error).toBeUndefined();
        expect(tagOf(promote.tag)).toBe("UPDATE 1");
        const retitle = await s().query(
          `update public.derived_datasets set title = 'renamed' where id::text = ${sqlLit(savedId)}`,
        );
        expect(retitle.error).toBeUndefined();
        expect(tagOf(retitle.tag)).toBe("UPDATE 1");
        const kept = await s().expectOk(
          `select created_by::text as created_by from public.derived_datasets where id::text = ${sqlLit(savedId)}`,
        );
        expect(firstRow(kept).created_by).toBe(ALICE);
        // And the creator deletes.
        const ownDelete = await s().query(
          `delete from public.derived_datasets where id::text = ${sqlLit(draftId)}`,
        );
        expect(ownDelete.error).toBeUndefined();
        expect(tagOf(ownDelete.tag)).toBe("DELETE 1");
        await s().rollback();
      } finally {
        await dropDatasets(s(), [datasetId]);
      }
    });

    test("anon gets nothing: no rows read back, no writes land", async () => {
      const datasetId = await createDataset(s(), { createdBy: ALICE });
      try {
        await beginAs(ALICE);
        const savedId = await createDerived({ datasetId, status: "saved" });
        await s().asAnon();
        const read = await s().expectOk(
          `select id::text as id from public.derived_datasets where id::text = ${sqlLit(savedId)}`,
        );
        expect(read.length).toBe(0);
        await expectRaises(
          `insert into public.derived_datasets (title, spec, source_dataset_id, status)
         values ('anon row', '{}'::jsonb, ${sqlLit(datasetId)}, 'draft')`,
        );
        await s().rollback();
      } finally {
        await dropDatasets(s(), [datasetId]);
      }
    });

    test("the DDL's shape guards: status check, num_nonnulls, and the source FKs", async () => {
      const datasetId = await createDataset(s(), { createdBy: ALICE });
      try {
        await beginAs(ALICE);
        const existingId = await createDerived({ datasetId, status: "saved" });

        const statusError = await expectRaises(
          `insert into public.derived_datasets (title, spec, source_dataset_id, status)
         values ('bad status', '{}'::jsonb, ${sqlLit(datasetId)}, 'published')`,
        );
        expect(statusError).toContain("violates check constraint");
        // Neither source set (the num_nonnulls check) — the table-level
        // check's auto-generated name (derived_datasets_check), distinct
        // from the column check's derived_datasets_status_check.
        const noSourceError = await expectRaises(
          `insert into public.derived_datasets (title, spec, status)
         values ('no source', '{}'::jsonb, 'draft')`,
        );
        expect(noSourceError).toContain("derived_datasets_check");
        // BOTH sources set (derived-of-derived cannot also name a dataset).
        const bothSourcesError = await expectRaises(
          `insert into public.derived_datasets (title, spec, source_dataset_id, source_derived_id, status)
         values ('both sources', '{}'::jsonb, ${sqlLit(datasetId)}, ${sqlLit(existingId)}, 'draft')`,
        );
        expect(bothSourcesError).toContain("derived_datasets_check");
        // The source FKs — what makes save()'s unknown-source refusal real.
        const danglingDatasetError = await expectRaises(
          `insert into public.derived_datasets (title, spec, source_dataset_id, status)
         values ('dangling dataset', '{}'::jsonb, ${sqlLit(crypto.randomUUID())}, 'draft')`,
        );
        expect(danglingDatasetError).toContain("violates foreign key constraint");
        const danglingDerivedError = await expectRaises(
          `insert into public.derived_datasets (title, spec, source_derived_id, status)
         values ('dangling derived', '{}'::jsonb, ${sqlLit(crypto.randomUUID())}, 'draft')`,
        );
        expect(danglingDerivedError).toContain("violates foreign key constraint");
        await s().rollback();
      } finally {
        await dropDatasets(s(), [datasetId]);
      }
    });

    test("carries the Convex-mirroring indexes (by_status_and_source / by_source_and_creator)", async () => {
      const rows = await s().expectOk(
        `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and tablename = 'derived_datasets'`,
      );
      const names = rows.map((row) => String(row.indexname));
      expect(names).toContain("derived_by_status_source");
      expect(names).toContain("derived_by_source_creator");
      const byName = new Map(rows.map((row) => [String(row.indexname), String(row.indexdef)]));
      // indexdef renders identifiers/keywords in pg_get_indexdef's canonical
      // case — compare lower-cased.
      const statusSource = (byName.get("derived_by_status_source") ?? "").toLowerCase();
      expect(statusSource).toContain("status");
      expect(statusSource).toContain("coalesce(source_dataset_id, source_derived_id)");
      const sourceCreator = (byName.get("derived_by_source_creator") ?? "").toLowerCase();
      expect(sourceCreator).toContain("created_by");
      expect(sourceCreator).toContain("coalesce(source_dataset_id, source_derived_id)");
    });
  },
);

describe.skipIf(!dbUp())("stage 5 — dataset_rows_for_tiles cap realignment (0010)", () => {
  test("honors p_limit = 2000 (the row seam's width) and pages to exhaustion with stable cursors", async () => {
    const datasetId = await createGeospatialDatasetWithRows(2500);
    try {
      const page1 = await pageOf(datasetId, null, 2000);
      expect(page1.count).toBe(2000);
      expect(page1.hasNext).toBe(true);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await pageOf(datasetId, page1.nextCursor, 2000);
      expect(page2.count).toBe(500);
      expect(page2.hasNext).toBe(false);
      expect(page2.nextCursor).toBeNull();
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("clamps p_limit = 10^7 to the §5.5 default (5000); the bare default matches the signature", async () => {
    // 5201 rows: one MORE than the cap, so the clamp is observable (the
    // tranche-1 guard's point) and the probe row survives.
    const datasetId = await createGeospatialDatasetWithRows(5201);
    try {
      const huge = await pageOf(datasetId, null, 10_000_000);
      expect(huge.count).toBe(5000);
      expect(huge.hasNext).toBe(true);

      const defaulted = await pageOf(datasetId, null, null);
      expect(defaulted.count).toBe(5000);
      expect(defaulted.hasNext).toBe(true);

      // And the tail past the first defaulted page (200 rows remain).
      const tail = await pageOf(datasetId, defaulted.nextCursor, null);
      expect(tail.count).toBe(201);
      expect(tail.hasNext).toBe(false);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  }, 30_000);
  // The explicit bound (2026-11-06, #258's run): this test seeds 5201 rows
  // IN-TRANSACTION, so its speed pivots on the ambient planner stats — the
  // same pages that answer in ~0.8s under big-table stats take ~7s once a
  // prior suite's cleanup left the tables analyzed-small. CI's fresh
  // container sits on the fast side; the 30s bound absorbs the slow side
  // without masking anything functional (the assertions are unchanged).
});
