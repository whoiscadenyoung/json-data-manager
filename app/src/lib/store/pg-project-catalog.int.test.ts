// Integration tests — issue #256's catalog contract (owned vs linked
// artifacts; ADR 0018) against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), every statement awaited, everything
// rolled back at the end. Skips with a one-line message when the stack is
// unreachable.
//
// The matrix:
//   * owned-draft sharing — a dataset that is an OWNED artifact of a
//     project is readable by every member and writable by editors+ (the
//     ADR 0017 deferred clause, landing with #256's in-project create/
//     import — "adding a draft to a project IS sharing"); viewers read
//     only; outsiders stay blind. The clause is DRAFT-scoped: publishing
//     the dataset widens it to the whole catalog (the outsider starts
//     seeing it), and a PUBLISHED 'author' dataset stays creator-only even
//     when owned.
//   * linked drafts stay creator-governed — a LINKED membership does NOT
//     share a draft (D1: linked references catalog-visible datasets).
//   * kind domain — artifact_kind is dataset|derived only (0019 narrowed
//     it; map/app arrive with their phases).
//   * constraint honesty — duplicate adds raise 23505 verbatim; role and
//     sync_mode carry their check domains.
//   * pin/float/sync/revert at DB level — a manual linked add's edge pins
//     at head, the badge predicate (pinned_ref ≠ head ref) is exactly the
//     "update available" state, sync advances the pin (editor+), revert
//     repins an earlier version, and viewers answer 0 rows on all of it.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  addEntry,
  ALICE,
  BOB,
  CAROL,
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

/** Savepoint-wrapped statement expected to RAISE. Returns the message. */
async function expectRaises(text: string): Promise<string> {
  return await s().denied(text);
}

/**
 * Seeds the catalog fixture inside ALICE's transaction (call after
 * `beginAs(ALICE)`): project A (ALICE owner, BOB editor, CAROL viewer),
 * project B (ALICE owner, no other members — the outsider lens). Returns
 * the ids the tests need.
 */
async function seedCatalog(): Promise<{ projectA: string; projectB: string }> {
  const projectA = crypto.randomUUID();
  const projectB = crypto.randomUUID();
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectA)}, 'catalog A', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectB)}, 'catalog B', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectA)}, ${sqlLit(BOB)}, 'editor')`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectA)}, ${sqlLit(CAROL)}, 'viewer')`,
  );
  return { projectA, projectB };
}

describe.skipIf(!dbUp())("project catalog — owned vs linked (ADR 0018, #256)", () => {
  test("owned-draft sharing: members read it, editors write it, viewers can't, outsiders stay blind; publishing widens", async () => {
    await beginAs(ALICE);
    const seed = await seedCatalog();
    // The in-project import's shape: an owned DRAFT created by ALICE —
    // edit_policy 'locked' so the write denials below exercise the ROLE gate
    // (an open dataset is editable by every signed-in collaborator by
    // ADR 0009's trusted-collaborator posture, role or no role).
    const draft = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "locked",
      lifecycle: "draft",
    });
    await s().expectOk(
      `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
       values (${sqlLit(seed.projectA)}, ${sqlLit(draft)}, 'dataset', 'owned', 'manual')`,
    );
    try {
      // EDITOR (BOB): reads the draft (the creator arm doesn't admit him —
      // the project clause does) and WRITES it.
      await s().asUser(BOB);
      expect(
        await s().count(`select count(*) as n from public.datasets where id = ${sqlLit(draft)}`),
      ).toBe(1);
      const entryId = await addEntry(s(), draft, { label: "editor wrote" });
      expect(entryId.length).toBeGreaterThan(0);
      // VIEWER (CAROL): reads it; never writes.
      await s().asUser(CAROL);
      expect(
        await s().count(`select count(*) as n from public.datasets where id = ${sqlLit(draft)}`),
      ).toBe(1);
      await expectRaises(
        `insert into public.entries (dataset_id, data) values (${sqlLit(draft)}, '{"label":"viewer"}'::jsonb)`,
      );
      // OUTSIDER (BOB against project B's draft): blind — the no-existence-leak rule.
      // (Back to ALICE: the datasets INSERT is creator-claimed, and the
      // fixture names its creator.)
      await s().asUser(ALICE);
      const foreignDraft = await createDataset(s(), { createdBy: ALICE, lifecycle: "draft" });
      await s().expectOk(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
         values (${sqlLit(seed.projectB)}, ${sqlLit(foreignDraft)}, 'dataset', 'owned', 'manual')`,
      );
      await s().asUser(BOB);
      expect(
        await s().count(
          `select count(*) as n from public.datasets where id = ${sqlLit(foreignDraft)}`,
        ),
      ).toBe(0);
      // PUBLISHING WIDENS: flipping the draft to published (the
      // markImportComplete / publish flow's act) opens it to the catalog —
      // the outsider reads it now (lifecycle past draft + 'everyone').
      await s().asUser(ALICE);
      await s().expectOk(
        `update public.datasets set lifecycle = 'published' where id = ${sqlLit(foreignDraft)}`,
      );
      await s().asUser(BOB);
      expect(
        await s().count(
          `select count(*) as n from public.datasets where id = ${sqlLit(foreignDraft)}`,
        ),
      ).toBe(1);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [draft]);
    }
  });

  test("the clause is draft-scoped: a published 'author' owned dataset stays creator-only; linked drafts don't share", async () => {
    await beginAs(ALICE);
    const seed = await seedCatalog();
    // PUBLISHED + visibility 'author', OWNED by project A — the project
    // clause must NOT widen a published row (the ladder owns visibility
    // widening, #260).
    const authorDataset = await createDataset(s(), {
      createdBy: ALICE,
      lifecycle: "published",
      visibility: "author",
    });
    await s().expectOk(
      `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
       values (${sqlLit(seed.projectA)}, ${sqlLit(authorDataset)}, 'dataset', 'owned', 'manual')`,
    );
    // A DRAFT linked into project A — linked references catalog-visible
    // datasets, so a linked draft shares NOTHING.
    const linkedDraft = await createDataset(s(), { createdBy: ALICE, lifecycle: "draft" });
    await s().expectOk(
      `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
       values (${sqlLit(seed.projectA)}, ${sqlLit(linkedDraft)}, 'dataset', 'linked', 'manual')`,
    );
    try {
      await s().asUser(BOB);
      expect(
        await s().count(
          `select count(*) as n from public.datasets where id = ${sqlLit(authorDataset)}`,
        ),
      ).toBe(0);
      expect(
        await s().count(
          `select count(*) as n from public.datasets where id = ${sqlLit(linkedDraft)}`,
        ),
      ).toBe(0);
      // The creator still sees both (her own rows).
      await s().asUser(ALICE);
      expect(
        await s().count(
          `select count(*) as n from public.datasets where id in (${sqlLit(authorDataset)}, ${sqlLit(linkedDraft)})`,
        ),
      ).toBe(2);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [authorDataset, linkedDraft]);
    }
  });

  test("the lock yields to the project: an owned draft with edit_policy 'locked' is editor-writable", async () => {
    await beginAs(ALICE);
    const seed = await seedCatalog();
    const lockedDraft = await createDataset(s(), {
      createdBy: ALICE,
      editPolicy: "locked",
      lifecycle: "draft",
    });
    await s().expectOk(
      `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
       values (${sqlLit(seed.projectA)}, ${sqlLit(lockedDraft)}, 'dataset', 'owned', 'manual')`,
    );
    try {
      // BOB (editor, not the creator): the project editor arm admits the
      // write — sharing the draft shared the write, "IS sharing" verbatim.
      await s().asUser(BOB);
      const entryId = await addEntry(s(), lockedDraft, { label: "editor via project" });
      expect(entryId.length).toBeGreaterThan(0);
      // CAROL (viewer): the viewer arm reads, never writes.
      await s().asUser(CAROL);
      expect(
        await s().count(
          `select count(*) as n from public.datasets where id = ${sqlLit(lockedDraft)}`,
        ),
      ).toBe(1);
      await expectRaises(
        `insert into public.entries (dataset_id, data) values (${sqlLit(lockedDraft)}, '{"label":"viewer"}'::jsonb)`,
      );
      await s().rollback();
    } finally {
      await dropDatasets(s(), [lockedDraft]);
    }
  });

  test("kind domain + constraint honesty: map memberships refuse, duplicates raise 23505, domains carry", async () => {
    await beginAs(ALICE);
    const seed = await seedCatalog();
    const dataset = await createDataset(s(), { createdBy: ALICE });
    try {
      // The 0019 narrowing: map/app memberships arrive with their phases.
      const mapMessage = await expectRaises(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
         values (${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'map', 'linked', 'manual')`,
      );
      expect(mapMessage).toMatch(/artifact_kind/);
      // role + sync_mode domains.
      await expectRaises(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
         values (${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'dataset', 'borrowed', 'manual')`,
      );
      await expectRaises(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
         values (${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'dataset', 'linked', 'sometimes')`,
      );
      // The honest duplicate: the same (project, kind, artifact) twice.
      await s().expectOk(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
         values (${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'dataset', 'linked', 'manual')`,
      );
      const duplicate = await expectRaises(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
         values (${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'dataset', 'linked', 'manual')`,
      );
      expect(duplicate).toMatch(/duplicate key/);
      // derived stays a legal kind (the catalog's second section).
      await s().expectOk(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind, role, sync_mode)
         values (${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'derived', 'linked', 'manual')`,
      );
      await s().rollback();
    } finally {
      await dropDatasets(s(), [dataset]);
    }
  });

  test("pin/float/sync/revert at DB level: the badge predicate, editor-advanced sync, viewer denial", async () => {
    await beginAs(ALICE);
    const seed = await seedCatalog();
    const dataset = await createDataset(s(), { createdBy: ALICE });
    await addEntry(s(), dataset, { label: "v1 row" });
    const membership = crypto.randomUUID();
    await s().expectOk(
      `insert into public.project_artifacts (id, project_id, artifact_id, artifact_kind, role, sync_mode)
       values (${sqlLit(membership)}, ${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'dataset', 'linked', 'manual')`,
    );
    try {
      // Two frozen versions (v1 then v2 — the add pinned at v2's head).
      const v1 = await s().query(
        `select public.publish_version(${sqlLit(dataset)}, 'v1', ${sqlLit(`pk1-${membership}`)}, null) as id`,
      );
      expect(v1.error).toBeUndefined();
      await addEntry(s(), dataset, { label: "v2 row" });
      const v2 = await s().query(
        `select public.publish_version(${sqlLit(dataset)}, 'v2', ${sqlLit(`pk2-${membership}`)}, null) as id`,
      );
      expect(v2.error).toBeUndefined();
      const v2Id = String(firstRow(v2.rows).id);
      const v2Ref = await s().expectOk(
        `select ref from public.dataset_versions where id = ${sqlLit(v2Id)}`,
      );
      const headRef = String(firstRow(v2Ref).ref);
      // The linked+manual mint: the edge pins at the current head.
      await s().expectOk(
        `insert into public.consumer_references (consumer_id, consumer_kind, mode, pinned_version_id, pinned_ref, source_dataset_id)
         values (${sqlLit(membership)}, 'fork', 'pin', ${sqlLit(v2Id)}, ${sqlLit(headRef)}, ${sqlLit(dataset)})`,
      );
      // A source republish (v3) moves the head past the pin — the badge
      // predicate (pinned_ref ≠ head ref) is exactly "update available".
      await addEntry(s(), dataset, { label: "v3 row" });
      await s().expectOk(
        `select public.publish_version(${sqlLit(dataset)}, 'v3', ${sqlLit(`pk3-${membership}`)}, null)`,
      );
      const drifted = await s().expectOk(
        `select cr.pinned_ref as pin, (select dvr.ref from public.dataset_versions dvr
           where dvr.dataset_id = cr.source_dataset_id
           order by dvr.created_at desc limit 1) as head
         from public.consumer_references cr where cr.consumer_id = ${sqlLit(membership)}`,
      );
      const badge = firstRow(drifted);
      expect(badge.pin).not.toBe(badge.head);
      // SYNC advances (the editor arm of consumer_reference_owner — 0018).
      await s().asUser(BOB);
      await s().expectOk(
        `update public.consumer_references cr set mode = 'pin', pinned_ref = (
           select dvr.ref from public.dataset_versions dvr where dvr.dataset_id = cr.source_dataset_id
           order by dvr.created_at desc limit 1),
         pinned_version_id = (
           select dvr.id from public.dataset_versions dvr where dvr.dataset_id = cr.source_dataset_id
           order by dvr.created_at desc limit 1)
         where cr.consumer_id = ${sqlLit(membership)}`,
      );
      const synced = await s().expectOk(
        `select pinned_ref from public.consumer_references where consumer_id = ${sqlLit(membership)}`,
      );
      expect(String(firstRow(synced).pinned_ref)).toBe(String(badge.head));
      // REVERT restores an earlier pin.
      await s().expectOk(
        `update public.consumer_references cr set pinned_ref = ${sqlLit(String(badge.pin))},
         pinned_version_id = (
           select dvr.id from public.dataset_versions dvr
           where dvr.dataset_id = cr.source_dataset_id and dvr.ref = ${sqlLit(String(badge.pin))}
           limit 1)
         where cr.consumer_id = ${sqlLit(membership)}`,
      );
      const reverted = await s().expectOk(
        `select pinned_ref from public.consumer_references where consumer_id = ${sqlLit(membership)}`,
      );
      expect(String(firstRow(reverted).pinned_ref)).toBe(String(badge.pin));
      // VIEWER: every edge move answers 0 rows (the silent shape — a member
      // sees the rows, the write filters).
      await s().asUser(CAROL);
      await expect(
        s().denied(
          `update public.consumer_references set mode = 'float', pinned_ref = null, pinned_version_id = null
           where consumer_id = ${sqlLit(membership)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [dataset]);
    }
  });

  test("invariants: the 0019 backfill's shape holds — every pre-existing membership reads linked", async () => {
    await s().asAdmin();
    // The column defaults: a membership inserted without role/sync_mode
    // lands linked+manual (the new contract's defaults; the migration's
    // backfill only moved float-edge rows to auto).
    await beginAs(ALICE);
    const seed = await seedCatalog();
    const dataset = await createDataset(s(), { createdBy: ALICE });
    try {
      await s().expectOk(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind)
         values (${sqlLit(seed.projectA)}, ${sqlLit(dataset)}, 'dataset')`,
      );
      const defaults = await s().expectOk(
        `select role, sync_mode from public.project_artifacts
         where project_id = ${sqlLit(seed.projectA)} and artifact_id = ${sqlLit(dataset)}`,
      );
      const row = firstRow(defaults);
      expect(row.role).toBe("linked");
      expect(row.sync_mode).toBe("manual");
      await s().rollback();
    } finally {
      await dropDatasets(s(), [dataset]);
    }
  });
});
