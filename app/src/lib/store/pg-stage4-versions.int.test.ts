// Integration tests — stage 4's versioning + publishing domain
// (docs/supabase-migration-design.md §3.5/§5.4/§4 matrix rows; issue #203's
// acceptance criteria) against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), every statement awaited (the
// single-pipelining lesson — one unawaited helper call interleaves its
// response frames into the next statement's parse), everything rolled back
// at the end. Works against CI's service container (SUPABASE_DB_URL) and the
// local stack unchanged. Skips with a one-line message when the stack is
// unreachable.
//
// Attribution-stamped fixtures (projects/collections/tags — the stamp
// triggers read auth.uid()) are created INSIDE the per-test transaction as a
// user, never by the admin connection — the maps-domain test's recorded
// constraint. Statements expected to RAISE (RPC gates, the #126 trigger,
// FK restrict) run savepoint-wrapped: a bare error aborts the transaction.
//
// Coverage: publish idempotency on publish_key; the dataset-scoped by-ref
// short-circuit (0011's parity patch); frozen-row immutability (no grants — the negative test);
// materialization shape; version-table RLS; the #126 retire-pin refusal
// (trigger + FK restrict via the retention path); keep-N retention with pin
// exemptions; consumer_reference fork-edge ownership; creator-only
// projects/bundles; the tightened collection_datasets write policies.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ALICE,
  BOB,
  addEntry,
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

/** Publishes one version as the CURRENT user; returns the version id. */
async function publish(datasetId: string, label: string, key: string): Promise<string> {
  const run = await s().query(
    `select public.publish_version(${sqlLit(datasetId)}, ${sqlLit(label)}, ${sqlLit(key)}, null) as id`,
  );
  expect(run.error).toBeUndefined();
  const id = firstRow(run.rows).id;
  expect(typeof id).toBe("string");
  return id as string;
}

/**
 * Savepoint-wrapped statement expected to RAISE (an RPC gate, a trigger, an
 * FK). Returns the error message for matching; throws when it succeeded.
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

/** One inline-geometry entry (the materialization's happy input). */
async function addGeometryEntry(datasetId: string, label: string, lat: number): Promise<string> {
  const data = JSON.stringify({ label, lat });
  const geometry = JSON.stringify({ coordinates: [lat, lat + 1], type: "Point" });
  const rows = await s().expectOk(
    `insert into public.entries (dataset_id, data, geometry_type) values (${sqlLit(datasetId)}, ${sqlLit(data)}, 'Point') returning id::text as id`,
  );
  const entryId = rows[0].id as string;
  await s().expectOk(
    `insert into public.geometries (dataset_id, entry_id, source, type, created_by)
     values (${sqlLit(datasetId)}, ${sqlLit(entryId)}, ${sqlLit(geometry)}, 'Point', ${sqlLit(ALICE)})`,
  );
  return entryId;
}

/** One tag, created INSIDE a user transaction (the stamp trigger). */
async function createTag(datasetId: string, name: string, versionId: string): Promise<string> {
  const rows = await s().expectOk(
    `insert into public.tags (dataset_id, name, version_id)
     values (${sqlLit(datasetId)}, ${sqlLit(name)}, ${sqlLit(versionId)}) returning id::text as id`,
  );
  return rows[0].id as string;
}

describe.skipIf(!dbUp())("stage 4 — publish_version (§5.4)", () => {
  test("materializes the live rows verbatim, with stable ordinals and provenance entry ids", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addGeometryEntry(datasetId, "alpha", 1.5);
      await addEntry(s(), datasetId, { label: "beta", lat: 2.5 });

      await beginAs(BOB);
      const versionId = await publish(datasetId, "v1", `pk-${datasetId}`);

      const entries = await s().expectOk(
        `select data, geometry, geometry_type, bbox, ordinal, entry_id::text as entry_id
         from public.version_entries where version_id = ${sqlLit(versionId)} order by ordinal`,
      );
      expect(entries.length).toBe(2);
      const first = firstRow(entries);
      expect(String(first.data)).toContain("alpha");
      // The geometry froze VERBATIM (the inline source), with its bbox.
      expect(String(first.geometry)).toContain("Point");
      expect(first.bbox).not.toBeNull();
      expect(first.geometry_type).toBe("Point");
      expect(first.ordinal).toBe("1");
      expect(first.entry_id).not.toBeNull();

      // Provenance only: deleting the live entry nulls the frozen row's
      // entry_id, and the jsonb row — the truth — survives.
      await s().asAdmin();
      const entryRows = await s().expectOk(
        `select id::text as id from public.entries where dataset_id = ${sqlLit(datasetId)} order by created_at limit 1`,
      );
      const entryId = String(firstRow(entryRows).id);
      await s().expectOk(`delete from public.entries where id = ${sqlLit(entryId)}`);
      const after = await s().expectOk(
        `select entry_id, data from public.version_entries where version_id = ${sqlLit(versionId)} order by ordinal`,
      );
      expect(after.length).toBe(2);
      const firstAfter = firstRow(after);
      expect(firstAfter.entry_id).toBeNull();
      expect(String(firstAfter.data)).toContain("alpha");
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("is idempotent on publish_key: a double-submit yields exactly one version", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addEntry(s(), datasetId, { label: "one" });
      await beginAs(ALICE);
      const key = `pk-idem-${datasetId}`;
      const firstId = await publish(datasetId, "v1", key);
      await s().expectOk(
        `insert into public.entries (dataset_id, data) values (${sqlLit(datasetId)}, ${sqlLit(JSON.stringify({ label: "two" }))}::jsonb)`,
      );
      // The SAME key answers the SAME version — even with new rows since,
      // and even under a different label: the freeze short-circuit.
      const secondId = await publish(datasetId, "v2", key);
      expect(secondId).toBe(firstId);
      const counts = await s().expectOk(
        `select count(*) as n from public.dataset_versions where dataset_id = ${sqlLit(datasetId)}`,
      );
      expect(firstRow(counts).n).toBe("1");
      // The materialization carries exactly the FIRST freeze's rows.
      const frozen = await s().count(
        `select count(*) as n from public.version_entries where version_id = ${sqlLit(firstId)}`,
      );
      expect(frozen).toBe(1);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("a ref never freezes twice: the SAME chain's refreeze short-circuits; a foreign chain's colliding ref is refused", async () => {
    const datasetA = await createDataset(s(), { createdBy: ALICE });
    const datasetB = await createDataset(s(), { createdBy: BOB });
    try {
      await beginAs(ALICE);
      const ref = `ref-scope-${datasetA.slice(0, 8)}`;
      const existingId = await publish(datasetA, "v1", ref);
      // The SAME dataset refreezing its own ref answers the existing row —
      // the freeze short-circuit, now scoped to the caller's chain (the
      // stage-6 parity patch on 0009's global lookup).
      const refrozenId = await publish(datasetA, "v2", ref);
      expect(refrozenId).toBe(existingId);
      // A DIFFERENT user publishing a DIFFERENT dataset under the SAME ref
      // is NOT answered with the foreign row. publish_key = ref by
      // construction, so the collision flows past the scoped by-ref lookup
      // into ON CONFLICT (publish_key) — and the race re-select is scoped
      // TOO (0011, both existing-row returns): the RPC answers NULL, the
      // caller's "no version id" error, instead of someone else's row.
      // 0009's global lookups handed back datasetA's version id here —
      // exactly the cross-chain leak the patch removes (proven on the live
      // stack: the by-ref guard alone still leaked through the race arm).
      await s().asUser(BOB);
      const clash = await s().query(
        `select public.publish_version(${sqlLit(datasetB)}, 'v1', ${sqlLit(ref)}, null) as id`,
      );
      expect(clash.error).toBeUndefined();
      expect(firstRow(clash.rows).id).toBeNull();
      // Nothing froze on dataset B — no version answered, none created.
      const bVersions = await s().count(
        `select count(*) as n from public.dataset_versions where dataset_id = ${sqlLit(datasetB)}`,
      );
      expect(bVersions).toBe(0);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetA, datasetB]);
    }
  });

  test("the gate: a locked dataset answers only to its creator; a frozen row denies everyone", async () => {
    const lockedId = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });
    const frozenId = await createDataset(s(), { createdBy: ALICE, frozenLineage: true });
    try {
      await beginAs(BOB);
      const lockedTry = await expectRaises(
        `select public.publish_version(${sqlLit(lockedId)}, 'v1', ${sqlLit(`pk-${lockedId}`)}, null) as id`,
      );
      expect(lockedTry).toMatch(/not writable/i);

      const frozenTry = await expectRaises(
        `select public.publish_version(${sqlLit(frozenId)}, 'v1', ${sqlLit(`pk-${frozenId}`)}, null) as id`,
      );
      // can_edit_dataset denies EVERYONE on a lineage-marked row — the
      // creator included (ADR 0009, absolute read-only).
      expect(frozenTry).toMatch(/not writable/i);

      await s().asUser(ALICE);
      const versionId = await publish(lockedId, "v1", `pk-${lockedId}`);
      expect(typeof versionId).toBe("string");
      await s().rollback();
    } finally {
      await dropDatasets(s(), [lockedId, frozenId]);
    }
  });

  test("the oversized guard (#224): storage-backed geometry refuses the freeze loudly — nothing frozen, nothing prunable", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addEntry(s(), datasetId, { label: "inline", lat: 1.0 });
      // A storage-backed oversized geometry: source_path set, source null —
      // the > 256 KB import path's shape. Whether the object behind the
      // path exists is irrelevant: the guard is catalog-level (0009's
      // recorded reason — no SQL path can read Storage bytes), which is
      // exactly why a prune of the live objects can never 404 a frozen
      // read (issue #224's consumer criterion).
      await s().asAdmin();
      const entryRows = await s().expectOk(
        `select id::text as id from public.entries where dataset_id = ${sqlLit(datasetId)} limit 1`,
      );
      await s().expectOk(
        `insert into public.geometries (dataset_id, entry_id, source_path, type, created_by)
         values (${sqlLit(datasetId)}, ${sqlLit(String(firstRow(entryRows).id))}, '/objects/oversized/row-0.geojson', 'Point', ${sqlLit(ALICE)})`,
      );
      await beginAs(ALICE);
      const refused = await expectRaises(
        `select public.publish_version(${sqlLit(datasetId)}, 'v1', ${sqlLit(`pk-${datasetId}`)}, null) as id`,
      );
      // The actionable copy, verbatim (0012's guard).
      expect(refused).toMatch(/storage-backed oversized geometry/i);
      expect(refused).toMatch(/Simplify or re-import/);
      // Loud refusal means NOTHING froze — no version row, no frozen
      // entries — so no version surface can silently render a missing
      // payload.
      const versions = await s().count(
        `select count(*) as n from public.dataset_versions where dataset_id = ${sqlLit(datasetId)}`,
      );
      expect(versions).toBe(0);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("frozen rows are immutable by construction: no authenticated role can write them", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addEntry(s(), datasetId, { label: "one" });
      await beginAs(ALICE);
      const versionId = await publish(datasetId, "v1", `pk-${datasetId}`);
      await s().asUser(BOB);
      // The grants were revoked from every role (0009) — the denial is the
      // privilege error for writes on BOTH tables, any authenticated user.
      await expect(
        s().denied(
          `insert into public.dataset_versions (dataset_id, ref, version_label, lineage, created_by)
           values (${sqlLit(datasetId)}, 'rogue-ref', 'v9', '{}'::jsonb, ${sqlLit(BOB)})`,
        ),
      ).resolves.toMatch(/permission denied|row-level/i);
      await expect(
        s().denied(
          `update public.dataset_versions set version_label = 'vX' where id = ${sqlLit(versionId)}`,
        ),
      ).resolves.toMatch(/permission denied|row-level/i);
      await expect(
        s().denied(`delete from public.dataset_versions where id = ${sqlLit(versionId)}`),
      ).resolves.toMatch(/permission denied|row-level/i);
      await expect(
        s().denied(
          `insert into public.version_entries (version_id, data, ordinal) values (${sqlLit(versionId)}, '{"x":1}'::jsonb, 99)`,
        ),
      ).resolves.toMatch(/permission denied|row-level/i);
      await expect(
        s().denied(`delete from public.version_entries where version_id = ${sqlLit(versionId)}`),
      ).resolves.toMatch(/permission denied|row-level/i);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});

describe.skipIf(!dbUp())("stage 4 — version-table RLS (§4)", () => {
  test("a draft's chain is invisible to others; the published chain and its entries are readable", async () => {
    const draftId = await createDataset(s(), { createdBy: ALICE, lifecycle: "draft" });
    const openId = await createDataset(s(), { createdBy: ALICE });
    try {
      await beginAs(ALICE);
      for (const datasetId of [draftId, openId]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- fixture writes, sequential by design (the wire client pipelines one statement at a time).
        await addEntry(s(), datasetId, { label: "row" });
        // oxlint-disable-next-line eslint/no-await-in-loop -- fixture writes, sequential by design.
        await publish(datasetId, "v1", `pk-rls-${datasetId.slice(0, 8)}`);
      }
      await s().asUser(BOB);
      // The draft is invisible to BOB (can_view_dataset), so is its chain
      // and its materialized rows.
      expect(
        await s().count(
          `select count(*) as n from public.dataset_versions where dataset_id = ${sqlLit(draftId)}`,
        ),
      ).toBe(0);
      expect(
        await s().count(
          `select count(*) as n from public.version_entries
           where version_id in (select id from public.dataset_versions where dataset_id = ${sqlLit(draftId)})`,
        ),
      ).toBe(0);
      // The open dataset's chain and entries read fine.
      const openVersions = await s().count(
        `select count(*) as n from public.dataset_versions where dataset_id = ${sqlLit(openId)}`,
      );
      expect(openVersions).toBe(1);
      const openEntries = await s().count(
        `select count(*) as n from public.version_entries
         where version_id in (select id from public.dataset_versions where dataset_id = ${sqlLit(openId)})`,
      );
      expect(openEntries).toBeGreaterThanOrEqual(1);
      // The creator still reads her own draft's chain.
      await s().asUser(ALICE);
      expect(
        await s().count(
          `select count(*) as n from public.dataset_versions where dataset_id = ${sqlLit(draftId)}`,
        ),
      ).toBe(1);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [draftId, openId]);
    }
  });

  test("the 0008 RETURNING shape passes on every new table the UI writes with .select()", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addEntry(s(), datasetId, { label: "row" });
      await beginAs(ALICE);
      const versionId = await publish(datasetId, "v1", `pk-${datasetId}`);

      // tags (SELECT is using(true) — no definer helper, so RETURNING passes).
      const tagRow = await s().query(
        `insert into public.tags (dataset_id, name, version_id) values (${sqlLit(datasetId)}, 'v1', ${sqlLit(versionId)}) returning id`,
      );
      expect(tagRow.error).toBeUndefined();
      expect(typeof String(firstRow(tagRow.rows).id)).toBe("string");

      // projects + project_artifacts (creator-direct / other-table predicates).
      const projectRow = await s().query(
        `insert into public.projects (title) values ('p') returning id`,
      );
      expect(projectRow.error).toBeUndefined();
      const projectId = String(firstRow(projectRow.rows).id);
      const artifactRow = await s().query(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind)
         values (${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset') returning id`,
      );
      expect(artifactRow.error).toBeUndefined();
      const artifactId = String(firstRow(artifactRow.rows).id);

      // publish_bundles + members (creator-direct / other-table predicates).
      const bundleRow = await s().query(
        `insert into public.publish_bundles (project_id, title) values (${sqlLit(projectId)}, 'b') returning id`,
      );
      expect(bundleRow.error).toBeUndefined();
      const bundleId = String(firstRow(bundleRow.rows).id);
      const memberRow = await s().query(
        `insert into public.publish_bundle_members (bundle_id, kind, dataset_key, publish)
         values (${sqlLit(bundleId)}, 'dataset', ${sqlLit(datasetId)}, true) returning id`,
      );
      expect(memberRow.error).toBeUndefined();
      const memberId = String(firstRow(memberRow.rows).id);

      // consumer_references (SELECT using(true)).
      const edgeRow = await s().query(
        `insert into public.consumer_references (consumer_id, consumer_kind, mode, source_dataset_id)
         values (${sqlLit(artifactId)}, 'fork', 'float', ${sqlLit(datasetId)}) returning id`,
      );
      expect(edgeRow.error).toBeUndefined();
      expect(typeof String(firstRow(edgeRow.rows).id)).toBe("string");

      void memberId;
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});

describe.skipIf(!dbUp())("stage 4 — the #126 retire-pin refusal", () => {
  test("retiring a tag refuses while a consumer pins its version; unpinned retires; the FK blocks version deletion", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addEntry(s(), datasetId, { label: "one" });
      await beginAs(ALICE);
      const versionId = await publish(datasetId, "v1", `pk-${datasetId}`);
      const tagId = await createTag(datasetId, "v1", versionId);

      // The consumer side: a project + a dataset membership + its fork edge
      // PINNED to the version (the pin identity: row + ref).
      const projectId = crypto.randomUUID();
      const artifactId = crypto.randomUUID();
      await s().expectOk(
        `insert into public.projects (id, title, created_by) values (${sqlLit(projectId)}, 'pin-project', ${sqlLit(ALICE)})`,
      );
      await s().expectOk(
        `insert into public.project_artifacts (id, project_id, artifact_id, artifact_kind, added_by)
         values (${sqlLit(artifactId)}, ${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset', ${sqlLit(ALICE)})`,
      );
      await s().expectOk(
        `insert into public.consumer_references (consumer_id, consumer_kind, mode, source_dataset_id, pinned_version_id, pinned_ref)
         values (${sqlLit(artifactId)}, 'fork', 'pin', ${sqlLit(datasetId)}, ${sqlLit(versionId)}, ${sqlLit(`pk-${datasetId}`)})`,
      );

      // Soft retire (retired_at null → set): the trigger REFUSES.
      await expect(
        s().denied(`update public.tags set retired_at = now() where id = ${sqlLit(tagId)}`),
      ).resolves.toMatch(/pinned by a consumer/i);
      // Hard delete: the same guard.
      await expect(
        s().denied(`delete from public.tags where id = ${sqlLit(tagId)}`),
      ).resolves.toMatch(/pinned by a consumer/i);
      // The VERSION cannot be deleted while pinned — the RESTRICT FK. Only
      // the definer path may delete version rows at all, so this runs as the
      // owner (grants don't apply to it; the FK still does).
      await s().asAdmin();
      await expect(
        s().denied(`delete from public.dataset_versions where id = ${sqlLit(versionId)}`),
      ).resolves.toMatch(/violates foreign key|still referenced/i);

      // Float the consumer (unpin) — now the retire passes and the pin's
      // version_id survives (a retired tag stops pinning via retired_at).
      await s().asUser(ALICE);
      await s().expectOk(
        `update public.consumer_references set mode = 'float', pinned_version_id = null, pinned_ref = null
         where consumer_id = ${sqlLit(artifactId)} and consumer_kind = 'fork'`,
      );
      await s().expectOk(`update public.tags set retired_at = now() where id = ${sqlLit(tagId)}`);
      const retired = await s().expectOk(
        `select retired_at is not null as retired from public.tags where id = ${sqlLit(tagId)}`,
      );
      expect(firstRow(retired).retired).toBe("t");
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("the guard steps aside for cascades: a dataset delete walks its tags even while pinned", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addEntry(s(), datasetId, { label: "one" });
      await beginAs(ALICE);
      const versionId = await publish(datasetId, "v1", `pk-${datasetId}`);
      await createTag(datasetId, "v1", versionId);
      // A live CONSUMER pin on this version: a DIRECT tag delete would be
      // refused (the trigger), but the DATASET delete cascades both tables
      // (source FK + dataset_id FK, unspecified order) — the depth>1 bypass
      // keeps the cascade from deadlocking on FK order either way.
      await s().expectOk(
        `insert into public.consumer_references (consumer_id, consumer_kind, mode, source_dataset_id, pinned_version_id, pinned_ref)
         values ('map-edge-cascade', 'map', 'pin', ${sqlLit(datasetId)}, ${sqlLit(versionId)}, ${sqlLit(`pk-${datasetId}`)})`,
      );
      await expect(
        s().denied(`delete from public.tags where dataset_id = ${sqlLit(datasetId)}`),
      ).resolves.toMatch(/pinned by a consumer/i);
      await s().asAdmin();
      await s().expectOk(`delete from public.datasets where id = ${sqlLit(datasetId)}`);
      const left = await s().count(
        `select count(*) as n from public.tags where dataset_id = ${sqlLit(datasetId)}`,
      );
      expect(left).toBe(0);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});

describe.skipIf(!dbUp())("stage 4 — keep-N retention", () => {
  test("keeps the newest N unpinned versions; pins, consumer pins, and live tags are exempt", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await beginAs(ALICE);
      const refs: Array<string> = [];
      const versionIds: Array<string> = [];
      for (const index of [1, 2, 3, 4, 5]) {
        const ref = `ret-${index}-${datasetId.slice(0, 8)}`;
        refs.push(ref);
        // oxlint-disable-next-line eslint/no-await-in-loop -- publishes are sequential by design: each freeze's chain grows on the previous.
        versionIds.push(await publish(datasetId, `v${String(index)}`, ref));
      }
      // The five publishes ran in ONE transaction, so created_at is
      // transaction-constant (the stage-3 wire-client lesson) — the
      // retention ranking needs distinct freeze times, which production
      // publishes have (one transaction each). Space them here.
      await s().asAdmin();
      for (const [index, versionId] of versionIds.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- ordered spacing, one statement per version.
        await s().expectOk(
          `update public.dataset_versions set created_at = now() - interval '1 hour' * ${String(versionIds.length - index)} where id = ${sqlLit(versionId ?? "")}`,
        );
      }
      await s().asUser(ALICE);
      // Live tag on the OLDEST (v1), policy pin on v2, keep 2: the unpinned
      // universe is {v3, v4, v5}, the newest 2 survive, v3 retires.
      await createTag(datasetId, "v1", versionIds[0] ?? "");
      await s().expectOk(
        `insert into public.version_policies (dataset_key, keep_versions, pinned_refs)
         values (${sqlLit(datasetId)}, 2, array[${sqlLit(refs[1] ?? "")}]::text[])`,
      );
      const retired = await s().query(
        `select public.enforce_version_retention(${sqlLit(datasetId)}) as n`,
      );
      expect(retired.error).toBeUndefined();
      expect(firstRow(retired.rows).n).toBe("1");
      const survivors = await s().expectOk(
        `select ref from public.dataset_versions where dataset_id = ${sqlLit(datasetId)} order by created_at`,
      );
      const survivorRefs = survivors.map((row) => row.ref);
      expect(survivorRefs).toContain(refs[0]); // live tag — never auto-retired
      expect(survivorRefs).toContain(refs[1]); // policy pin — exempt
      expect(survivorRefs).not.toContain(refs[2]); // oldest unpinned — retired
      expect(survivorRefs).toContain(refs[3]);
      expect(survivorRefs).toContain(refs[4]);
      expect(survivorRefs.length).toBe(4);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("retires past keep-N and sweeps the retired tag rows with them", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await beginAs(ALICE);
      const versionIds: Array<string> = [];
      for (const index of [1, 2, 3]) {
        // No policy row yet: keep defaults to 10, so the in-publish hook
        // retires nothing while the chain grows.
        // oxlint-disable-next-line eslint/no-await-in-loop -- publishes are sequential by design (the chain grows on the previous).
        const versionId = await publish(
          datasetId,
          `v${String(index)}`,
          `keep-${index}-${datasetId.slice(0, 8)}`,
        );
        versionIds.push(versionId);
      }
      // Distinct freeze times (the same transaction-constant created_at as
      // the exempt test — the victim must be determinably v1).
      await s().asAdmin();
      for (const [index, versionId] of versionIds.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- ordered spacing, one statement per version.
        await s().expectOk(
          `update public.dataset_versions set created_at = now() - interval '1 hour' * ${String(versionIds.length - index)} where id = ${sqlLit(versionId ?? "")}`,
        );
      }
      await s().asUser(ALICE);
      // Retire the OLDEST tag; it stops pinning but its ROW still
      // FK-restricts — the retention pass sweeps retired tag rows on
      // victims first.
      await createTag(datasetId, "v1", versionIds[0] ?? "");
      await s().expectOk(
        `update public.tags set retired_at = now() where dataset_id = ${sqlLit(datasetId)} and name = 'v1'`,
      );
      await s().expectOk(
        `insert into public.version_policies (dataset_key, keep_versions) values (${sqlLit(datasetId)}, 2)`,
      );
      const retired = await s().query(
        `select public.enforce_version_retention(${sqlLit(datasetId)}) as n`,
      );
      expect(firstRow(retired.rows).n).toBe("1");
      const survivors = await s().count(
        `select count(*) as n from public.dataset_versions where dataset_id = ${sqlLit(datasetId)}`,
      );
      expect(survivors).toBe(2);
      const tags = await s().count(
        `select count(*) as n from public.tags where dataset_id = ${sqlLit(datasetId)}`,
      );
      expect(tags).toBe(0);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });

  test("the gate: a locked chain's non-creator is refused; the owner passes", async () => {
    const lockedId = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });
    try {
      await beginAs(BOB);
      const refused = await expectRaises(
        `select public.enforce_version_retention(${sqlLit(lockedId)}) as n`,
      );
      expect(refused).toMatch(/not the chain owner/i);
      await s().asUser(ALICE);
      const allowed = await s().query(
        `select public.enforce_version_retention(${sqlLit(lockedId)}) as n`,
      );
      expect(allowed.error).toBeUndefined();
      expect(firstRow(allowed.rows).n).toBe("0");
      await s().rollback();
    } finally {
      await dropDatasets(s(), [lockedId]);
    }
  });
});

describe.skipIf(!dbUp())("stage 4 — consumer_references + policies RLS", () => {
  test("fork edges answer to the membership's project owner; map edges are shared; policy rows answer to the anchor owner", async () => {
    const datasetId = await createDataset(s(), { createdBy: ALICE });
    try {
      await addEntry(s(), datasetId, { label: "row" });
      await beginAs(ALICE);
      // Attribution-stamped fixtures run inside ALICE's transaction.
      const projectId = crypto.randomUUID();
      const artifactId = crypto.randomUUID();
      await s().expectOk(
        `insert into public.projects (id, title, created_by) values (${sqlLit(projectId)}, 'alice-private', ${sqlLit(ALICE)})`,
      );
      await s().expectOk(
        `insert into public.project_artifacts (id, project_id, artifact_id, artifact_kind, added_by)
         values (${sqlLit(artifactId)}, ${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset', ${sqlLit(ALICE)})`,
      );
      await s().expectOk(
        `insert into public.consumer_references (consumer_id, consumer_kind, mode, source_dataset_id)
         values (${sqlLit(artifactId)}, 'fork', 'float', ${sqlLit(datasetId)})`,
      );
      // A map edge — shared artifact, any signed-in user may adjust it.
      const mapEdgeId = crypto.randomUUID();
      await s().expectOk(
        `insert into public.consumer_references (id, consumer_id, consumer_kind, mode, source_dataset_id)
         values (${sqlLit(mapEdgeId)}, 'map-edge-1', 'map', 'float', ${sqlLit(datasetId)})`,
      );
      // The chain needs a head for a pin to name.
      await publish(datasetId, "v1", `pk-rls-${datasetId.slice(0, 8)}`);

      await s().asUser(BOB);
      // BOB reads both edges (SELECT authenticated — the badge walks).
      const readable = await s().count(`select count(*) as n from public.consumer_references`);
      expect(readable).toBe(2);
      // BOB may NOT touch ALICE's fork edge (her project, her edge) — the
      // write policy filters it to 0 rows.
      await expect(
        s().denied(
          `update public.consumer_references set mode = 'pin', pinned_version_id = (select id from public.dataset_versions where dataset_id = ${sqlLit(datasetId)} limit 1), pinned_ref = 'x'
           where consumer_id = ${sqlLit(artifactId)} and consumer_kind = 'fork'`,
        ),
      ).resolves.toMatch(/0 rows|row-level/i);
      // But the MAP edge is anyone's to adjust (the recorded exception).
      await s().expectOk(
        `update public.consumer_references set mode = 'pin', pinned_version_id = (select id from public.dataset_versions where dataset_id = ${sqlLit(datasetId)} limit 1), pinned_ref = 'x'
         where id = ${sqlLit(mapEdgeId)}`,
      );
      // And ALICE's policy row is invisible to BOB (defaults answer), while
      // ALICE reads it.
      expect(
        await s().count(
          `select count(*) as n from public.version_policies where dataset_key = ${sqlLit(datasetId)}`,
        ),
      ).toBe(0);
      await s().asUser(ALICE);
      await s().expectOk(
        `insert into public.version_policies (dataset_key, keep_versions) values (${sqlLit(datasetId)}, 5)`,
      );
      expect(
        await s().count(
          `select count(*) as n from public.version_policies where dataset_key = ${sqlLit(datasetId)}`,
        ),
      ).toBe(1);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [datasetId]);
    }
  });
});

describe.skipIf(!dbUp())(
  "stage 4 — projects/bundles creator-only + artifact_count lockstep",
  () => {
    test("a foreign user reads no projects, bundles, or members; the owner's writes answer rows", async () => {
      const datasetId = await createDataset(s(), { createdBy: ALICE });
      try {
        await beginAs(ALICE);
        const projectId = crypto.randomUUID();
        await s().expectOk(
          `insert into public.projects (id, title, created_by) values (${sqlLit(projectId)}, 'p', ${sqlLit(ALICE)})`,
        );
        await s().expectOk(
          `insert into public.project_artifacts (project_id, artifact_id, artifact_kind)
         values (${sqlLit(projectId)}, ${sqlLit(datasetId)}, 'dataset')`,
        );
        // The lockstep trigger kept artifact_count exact (same transaction).
        const count = await s().expectOk(
          `select artifact_count from public.projects where id = ${sqlLit(projectId)}`,
        );
        expect(firstRow(count).artifact_count).toBe("1");

        const bundleId = crypto.randomUUID();
        const memberId = crypto.randomUUID();
        await s().expectOk(
          `insert into public.publish_bundles (id, project_id, title) values (${sqlLit(bundleId)}, ${sqlLit(projectId)}, 'press')`,
        );
        await s().expectOk(
          `insert into public.publish_bundle_members (id, bundle_id, kind, dataset_key, publish)
         values (${sqlLit(memberId)}, ${sqlLit(bundleId)}, 'dataset', ${sqlLit(datasetId)}, true)`,
        );

        await s().asUser(BOB);
        expect(await s().count(`select count(*) as n from public.projects`)).toBe(0);
        expect(await s().count(`select count(*) as n from public.publish_bundles`)).toBe(0);
        expect(await s().count(`select count(*) as n from public.publish_bundle_members`)).toBe(0);
        // BOB cannot checkpoint ALICE's member (creator-only; the UPDATE
        // filters to 0 rows — the silent-denial shape the store surfaces).
        await expect(
          s().denied(
            `update public.publish_bundle_members set status = 'published' where id = ${sqlLit(memberId)}`,
          ),
        ).resolves.toMatch(/0 rows|row-level/i);
        await s().rollback();
      } finally {
        await dropDatasets(s(), [datasetId]);
      }
    });
  },
);

describe.skipIf(!dbUp())("stage 4 — collection_datasets policies tightened (carry fix)", () => {
  test("membership writes answer the dataset's visibility AND edit policy; reads stay open", async () => {
    const lockedId = await createDataset(s(), { createdBy: ALICE, editPolicy: "locked" });
    const aliceDraftId = await createDataset(s(), { createdBy: ALICE, lifecycle: "draft" });
    const openId = await createDataset(s(), { createdBy: ALICE });
    const frozenId = await createDataset(s(), { createdBy: ALICE, frozenLineage: true });
    const bobDraftId = await createDataset(s(), { createdBy: BOB, lifecycle: "draft" });
    try {
      await beginAs(BOB);
      // The collection carries a stamp trigger — created inside BOB's
      // transaction (the shared catalog artifact anyone may make).
      const collectionId = crypto.randomUUID();
      await s().expectOk(
        `insert into public.collections (id, name) values (${sqlLit(collectionId)}, 'shelf')`,
      );
      // Any signed-in user may ADD an OPEN dataset's membership (the shared
      // catalog write the §4 matrix kept), including their OWN draft (BOB's
      // draft is visible + editable to BOB).
      await s().expectOk(
        `insert into public.collection_datasets (collection_id, dataset_id) values (${sqlLit(collectionId)}, ${sqlLit(openId)})`,
      );
      await s().expectOk(
        `insert into public.collection_datasets (collection_id, dataset_id) values (${sqlLit(collectionId)}, ${sqlLit(bobDraftId)})`,
      );
      // A LOCKED dataset denies its membership to a non-creator
      // (cms/sharing.test.ts:509-519's LOCK rejection, PG edition).
      await expect(
        s().denied(
          `insert into public.collection_datasets (collection_id, dataset_id) values (${sqlLit(collectionId)}, ${sqlLit(lockedId)})`,
        ),
      ).resolves.toMatch(/row-level|violates/i);
      // A FOREIGN draft is INVISIBLE to BOB (can_view_dataset: draft +
      // creator ALICE ≠ BOB) — the not-found denial shape.
      await expect(
        s().denied(
          `insert into public.collection_datasets (collection_id, dataset_id) values (${sqlLit(collectionId)}, ${sqlLit(aliceDraftId)})`,
        ),
      ).resolves.toMatch(/row-level|violates/i);
      // A FROZEN dataset denies EVERYONE (can_edit_dataset's lineage arm) —
      // even the creator's membership write (recorded divergence from the
      // Convex hook, which allowed organization ops on read-only rows).
      await s().asUser(ALICE);
      await expect(
        s().denied(
          `insert into public.collection_datasets (collection_id, dataset_id) values (${sqlLit(collectionId)}, ${sqlLit(frozenId)})`,
        ),
      ).resolves.toMatch(/row-level|violates/i);
      // The creator passes the visibility+policy gate on her locked dataset,
      // and her own draft rides the same gate through.
      await s().expectOk(
        `insert into public.collection_datasets (collection_id, dataset_id) values (${sqlLit(collectionId)}, ${sqlLit(lockedId)})`,
      );
      await s().expectOk(
        `insert into public.collection_datasets (collection_id, dataset_id) values (${sqlLit(collectionId)}, ${sqlLit(aliceDraftId)})`,
      );
      // Reads stay plain authenticated (the inert-row rule).
      await s().asUser(BOB);
      const memberships = await s().count(
        `select count(*) as n from public.collection_datasets where collection_id = ${sqlLit(collectionId)}`,
      );
      expect(memberships).toBe(4);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [lockedId, aliceDraftId, openId, frozenId, bobDraftId]);
    }
  });
});

describe.skipIf(!dbUp())("stage 6 — tags reads gate on dataset visibility (0011)", () => {
  test("a foreign draft's tags leak nothing; viewable datasets' tags read; the creator's RETURNING passes", async () => {
    // ALICE holds a DRAFT (private to her — can_view_dataset's lifecycle
    // arm) and a PUBLISHED dataset, each with one tag on its frozen version.
    const draftId = await createDataset(s(), { createdBy: ALICE, lifecycle: "draft" });
    const openId = await createDataset(s(), { createdBy: ALICE });
    try {
      await beginAs(ALICE);
      await addEntry(s(), draftId, { label: "draft-row" });
      await addEntry(s(), openId, { label: "open-row" });
      const draftVersion = await publish(draftId, "v1", `pk-draft-${draftId.slice(0, 8)}`);
      const openVersion = await publish(openId, "v1", `pk-open-${openId.slice(0, 8)}`);
      const draftTag = await createTag(draftId, "draft-pin", draftVersion);
      await createTag(openId, "open-pin", openVersion);

      // BOB — a signed-in outsider — reads NOTHING of the foreign draft's
      // tags (the existence leak 0009's flat `authenticated` SELECT allowed:
      // name, version pin state, and retired_at all leaked). The 0-row
      // filtered-read shape.
      await s().asUser(BOB);
      const leaked = await s().count(
        `select count(*) as n from public.tags where dataset_id = ${sqlLit(draftId)}`,
      );
      expect(leaked).toBe(0);
      // The tag row by id is equally invisible (get-tag reads).
      const byId = await s().count(
        `select count(*) as n from public.tags where id = ${sqlLit(draftTag)}`,
      );
      expect(byId).toBe(0);
      // The PUBLISHED dataset's tags read as before — visibility unchanged
      // for datasets BOB can view.
      const viewable = await s().count(
        `select count(*) as n from public.tags where dataset_id = ${sqlLit(openId)}`,
      );
      expect(viewable).toBe(1);

      // BOB's own insert on a viewable dataset reads STRAIGHT back through
      // INSERT..RETURNING — the 0008 lesson's creator clause answers the new
      // row (can_view_dataset reads datasets, whose row predates the
      // statement; the clause covers every browser insert path).
      const rows = await s().expectOk(
        `insert into public.tags (dataset_id, name, version_id)
         values (${sqlLit(openId)}, 'bob-pin', ${sqlLit(openVersion)}) returning id::text as id`,
      );
      expect(String(firstRow(rows).id)).toBeTruthy();

      // The creator still reads her own tags on both datasets — the
      // creator clause's day job.
      await s().asUser(ALICE);
      const hers = await s().count(
        `select count(*) as n from public.tags where dataset_id = ${sqlLit(draftId)}`,
      );
      expect(hers).toBe(1);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [draftId, openId]);
    }
  });
});
