// Integration tests — issue #255's role access matrix (project membership &
// roles; ADR 0017) against the local Supabase Postgres.
//
// Same wire-client pattern as the other pg-*.int.test.ts files: SQL spoken
// directly, roles switched inside a test-scoped transaction (`set local role
// authenticated` + request.jwt.claims), every statement awaited, everything
// rolled back at the end. Skips with a one-line message when the stack is
// unreachable.
//
// The matrix (ADR 0017; owner > editor > viewer; outsider = a non-member
// authenticated user — the fixture keeps a second project only ALICE
// belongs to, so BOB plays the outsider against it without a fourth
// fixture user):
//   * read      — members see the workspace (project row, membership rows,
//                 artifacts, bundles, bundle members); the outsider reads
//                 zero rows across the tables (the no-existence-leak rule).
//   * write     — editor adds/removes artifact memberships, presses bundles,
//                 checkpoints bundle members, and pins the fork's consumer
//                 edge; viewer and outsider answer 0 rows / RLS refusals on
//                 all of it.
//   * manage    — owner invites/roles/removes members through RLS; editor,
//                 viewer, and outsider are denied; the creator's own owner
//                 row is untouchable even by the owner (the guard trigger)
//                 while the project-delete cascade passes it (depth carve-
//                 out).
//   * settings  — only the owner writes or deletes the project row.
//   * invite    — project_invite_resolve resolves an email for the owner
//                 (case/whitespace-insensitively), answers null for an
//                 unknown email, raises for anyone below owner.
//   * invariants — the birth trigger gives every project a creator-owner
//                 row (the migration's backfill shape for pre-0018
//                 projects is that same row, stamped by hand), and the
//                 realtime publication carries both projects and
//                 project_members (the catalog check runs on the bare CI
//                 postgres too; the LIVE delivery proof is the membership
//                 test in pg-realtime.int.test.ts).

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

/**
 * Savepoint-wrapped statement expected to RAISE (an INSERT RLS refusal, a
 * trigger guard, an RPC gate). Returns the message; throws when it had an
 * effect.
 */
async function expectRaises(text: string): Promise<string> {
  return await s().denied(text);
}

/**
 * Seeds the matrix fixture inside ALICE's transaction (call after
 * `beginAs(ALICE)`): project A (ALICE owner, BOB editor, CAROL viewer) with
 * one published dataset membership + fork edge + bundle press state, and
 * project B (ALICE owner, no other members — the outsider lens). Returns
 * the ids the matrix tests need.
 */
async function seedMatrix(): Promise<{
  artifactA: string;
  bundleMemberA: string;
  datasetId: string;
  projectA: string;
  projectB: string;
  versionId: string;
}> {
  const projectA = crypto.randomUUID();
  const projectB = crypto.randomUUID();
  const artifactA = crypto.randomUUID();
  const bundleMemberA = crypto.randomUUID();
  // Projects: the birth trigger mints ALICE's owner row with each project.
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectA)}, 'matrix A', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values (${sqlLit(projectB)}, 'matrix B', ${sqlLit(ALICE)})`,
  );
  // The editor and viewer rows (owner-managed).
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectA)}, ${sqlLit(BOB)}, 'editor')`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values (${sqlLit(projectA)}, ${sqlLit(CAROL)}, 'viewer')`,
  );
  // One published dataset + its membership + fork edge + press state.
  const datasetId = await createDataset(s(), { createdBy: ALICE });
  await addEntry(s(), datasetId, { label: "row" });
  await s().expectOk(
    `insert into public.project_artifacts (id, project_id, artifact_id, artifact_kind)
     values (${sqlLit(artifactA)}, ${sqlLit(projectA)}, ${sqlLit(datasetId)}, 'dataset')`,
  );
  await s().expectOk(
    `insert into public.consumer_references (consumer_id, consumer_kind, mode, source_dataset_id)
     values (${sqlLit(artifactA)}, 'fork', 'float', ${sqlLit(datasetId)})`,
  );
  const published = await s().query(
    `select public.publish_version(${sqlLit(datasetId)}, 'v1', ${sqlLit(`pk-${artifactA}`)}, null) as id`,
  );
  expect(published.error).toBeUndefined();
  const versionId = String(firstRow(published.rows).id);
  const bundleA = crypto.randomUUID();
  await s().expectOk(
    `insert into public.publish_bundles (id, project_id, title) values (${sqlLit(bundleA)}, ${sqlLit(projectA)}, 'press A')`,
  );
  await s().expectOk(
    `insert into public.publish_bundle_members (id, bundle_id, kind, dataset_key)
     values (${sqlLit(bundleMemberA)}, ${sqlLit(bundleA)}, 'dataset', ${sqlLit(datasetId)})`,
  );
  return { artifactA, bundleMemberA, datasetId, projectA, projectB, versionId };
}

describe.skipIf(!dbUp())("project membership — the role access matrix (ADR 0017)", () => {
  test("read: members see the workspace; the outsider reads zero rows everywhere", async () => {
    await beginAs(ALICE);
    const seed = await seedMatrix();
    try {
      // OWNER (ALICE, current user): everything.
      expect(await s().count(`select count(*) as n from public.projects`)).toBe(2);
      // EDITOR (BOB): project A's whole workspace — including both other
      // members' rows (the members dialog) — but not project B's existence.
      await s().asUser(BOB);
      expect(await s().count(`select count(*) as n from public.projects`)).toBe(1);
      const titleRow = await s().expectOk(
        `select title from public.projects where id = ${sqlLit(seed.projectA)}`,
      );
      expect(String(firstRow(titleRow).title)).toBe("matrix A");
      expect(
        await s().count(
          `select count(*) as n from public.project_members where project_id = ${sqlLit(seed.projectA)}`,
        ),
      ).toBe(3);
      expect(
        await s().count(
          `select count(*) as n from public.project_artifacts where project_id = ${sqlLit(seed.projectA)}`,
        ),
      ).toBe(1);
      expect(
        await s().count(
          `select count(*) as n from public.publish_bundles where project_id = ${sqlLit(seed.projectA)}`,
        ),
      ).toBe(1);
      expect(await s().count(`select count(*) as n from public.publish_bundle_members`)).toBe(1);
      // VIEWER (CAROL): the same reads.
      await s().asUser(CAROL);
      expect(await s().count(`select count(*) as n from public.projects`)).toBe(1);
      expect(
        await s().count(
          `select count(*) as n from public.project_members where project_id = ${sqlLit(seed.projectA)}`,
        ),
      ).toBe(3);
      expect(await s().count(`select count(*) as n from public.publish_bundle_members`)).toBe(1);
      // OUTSIDER (BOB against project B — a project he holds no row for):
      // the no-existence-leak posture.
      await s().asUser(BOB);
      expect(
        await s().count(
          `select count(*) as n from public.projects where id = ${sqlLit(seed.projectB)}`,
        ),
      ).toBe(0);
      expect(
        await s().count(
          `select count(*) as n from public.project_members where project_id = ${sqlLit(seed.projectB)}`,
        ),
      ).toBe(0);
      expect(
        await s().count(
          `select count(*) as n from public.project_artifacts where project_id = ${sqlLit(seed.projectB)}`,
        ),
      ).toBe(0);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [seed.datasetId]);
    }
  });

  test("write: the editor manages references and presses bundles; viewer and outsider are denied", async () => {
    await beginAs(ALICE);
    const seed = await seedMatrix();
    try {
      // EDITOR (BOB): every content write on project-held work.
      await s().asUser(BOB);
      const bobArtifact = crypto.randomUUID();
      await s().expectOk(
        `insert into public.project_artifacts (id, project_id, artifact_id, artifact_kind)
         values (${sqlLit(bobArtifact)}, ${sqlLit(seed.projectA)}, ${sqlLit(seed.datasetId)}, 'derived')`,
      );
      await s().expectOk(`delete from public.project_artifacts where id = ${sqlLit(bobArtifact)}`);
      await s().expectOk(
        `insert into public.publish_bundles (id, project_id, title) values (${sqlLit(crypto.randomUUID())}, ${sqlLit(seed.projectA)}, 'bob presses')`,
      );
      // The editor checkpoints the running press's members (the press flow).
      await s().expectOk(
        `update public.publish_bundle_members set status = 'published' where id = ${sqlLit(seed.bundleMemberA)}`,
      );
      // The editor pins the membership's fork edge (the editor arm of
      // consumer_reference_owner — was creator-only before 0018).
      await s().expectOk(
        `update public.consumer_references set mode = 'pin', pinned_version_id = ${sqlLit(seed.versionId)}, pinned_ref = 'pk'
         where consumer_id = ${sqlLit(seed.artifactA)} and consumer_kind = 'fork'`,
      );
      // VIEWER (CAROL): every write answers the denial shapes — INSERTs
      // raise, UPDATE/DELETE filter to 0 rows.
      await s().asUser(CAROL);
      await expectRaises(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind)
         values (${sqlLit(seed.projectA)}, ${sqlLit(seed.datasetId)}, 'dataset')`,
      );
      await expect(
        s().denied(`delete from public.project_artifacts where id = ${sqlLit(seed.artifactA)}`),
      ).resolves.toMatch(/0 rows/);
      await expectRaises(
        `insert into public.publish_bundles (project_id, title) values (${sqlLit(seed.projectA)}, 'carol presses')`,
      );
      await expect(
        s().denied(
          `update public.publish_bundle_members set status = 'published' where id = ${sqlLit(seed.bundleMemberA)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      await expect(
        s().denied(
          `update public.consumer_references set mode = 'pin', pinned_version_id = ${sqlLit(seed.versionId)}, pinned_ref = 'pk'
           where consumer_id = ${sqlLit(seed.artifactA)} and consumer_kind = 'fork'`,
        ),
      ).resolves.toMatch(/0 rows/);
      // OUTSIDER (BOB against project B): writes read as not-found / raise.
      await s().asUser(BOB);
      await expectRaises(
        `insert into public.project_artifacts (project_id, artifact_id, artifact_kind)
         values (${sqlLit(seed.projectB)}, ${sqlLit(seed.datasetId)}, 'dataset')`,
      );
      await expectRaises(
        `insert into public.publish_bundles (id, project_id, title) values (${sqlLit(crypto.randomUUID())}, ${sqlLit(seed.projectB)}, 'outsider presses')`,
      );
      await expect(
        s().denied(
          `update public.projects set title = 'hijacked' where id = ${sqlLit(seed.projectB)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [seed.datasetId]);
    }
  });

  test("manage: only the owner manages members; the creator's owner row is permanent", async () => {
    await beginAs(ALICE);
    const seed = await seedMatrix();
    try {
      // OWNER (ALICE, current user): invite, re-role, remove — a full cycle
      // on a scratch project (the unique (project,user) pair rules out
      // re-inviting CAROL into A).
      const scratch = crypto.randomUUID();
      await s().expectOk(
        `insert into public.projects (id, title, created_by) values (${sqlLit(scratch)}, 'scratch', ${sqlLit(ALICE)})`,
      );
      await s().expectOk(
        `insert into public.project_members (project_id, user_id, role) values (${sqlLit(scratch)}, ${sqlLit(BOB)}, 'viewer')`,
      );
      await s().expectOk(
        `update public.project_members set role = 'editor' where project_id = ${sqlLit(scratch)} and user_id = ${sqlLit(BOB)}`,
      );
      await s().expectOk(
        `delete from public.project_members where project_id = ${sqlLit(scratch)} and user_id = ${sqlLit(BOB)}`,
      );
      // The creator's own owner row: untouchable even BY the owner — the
      // guard trigger refuses the update and the delete.
      const ownerMessage = await expectRaises(
        `update public.project_members set role = 'viewer' where project_id = ${sqlLit(seed.projectA)} and user_id = ${sqlLit(ALICE)}`,
      );
      expect(ownerMessage).toMatch(/always has an owner/);
      await expectRaises(
        `delete from public.project_members where project_id = ${sqlLit(seed.projectA)} and user_id = ${sqlLit(ALICE)}`,
      );
      // EDITOR (BOB): member management denied — INSERT raises; UPDATE /
      // DELETE filter to 0 rows (the rows ARE visible to a member, so the
      // denial is the silent shape, not a raise).
      await s().asUser(BOB);
      await expectRaises(
        `insert into public.project_members (project_id, user_id, role) values (${sqlLit(seed.projectA)}, ${sqlLit(CAROL)}, 'viewer')`,
      );
      await expect(
        s().denied(
          `update public.project_members set role = 'owner' where project_id = ${sqlLit(seed.projectA)} and user_id = ${sqlLit(CAROL)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      await expect(
        s().denied(
          `delete from public.project_members where project_id = ${sqlLit(seed.projectA)} and user_id = ${sqlLit(CAROL)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      // VIEWER (CAROL): the same denials.
      await s().asUser(CAROL);
      await expectRaises(
        `insert into public.project_members (project_id, user_id, role) values (${sqlLit(seed.projectA)}, ${sqlLit(BOB)}, 'viewer')`,
      );
      await expect(
        s().denied(
          `delete from public.project_members where project_id = ${sqlLit(seed.projectA)} and user_id = ${sqlLit(BOB)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      // OUTSIDER (BOB on project B): the members are INVISIBLE, so the
      // write filters to 0 rows without confirming any row exists.
      await s().asUser(BOB);
      await expect(
        s().denied(
          `delete from public.project_members where project_id = ${sqlLit(seed.projectB)} and user_id = ${sqlLit(ALICE)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [seed.datasetId]);
    }
  });

  test("settings + delete: the project row answers to the owner; the cascade passes the guarded row", async () => {
    await beginAs(ALICE);
    const seed = await seedMatrix();
    try {
      // OWNER (ALICE, current user): settings write lands.
      await s().expectOk(
        `update public.projects set title = 'matrix A renamed', description = 'd' where id = ${sqlLit(seed.projectA)}`,
      );
      const renamed = await s().expectOk(
        `select title from public.projects where id = ${sqlLit(seed.projectA)}`,
      );
      expect(String(firstRow(renamed).title)).toBe("matrix A renamed");
      // EDITOR: denied (0 rows — the row is visible, the write filters).
      await s().asUser(BOB);
      await expect(
        s().denied(
          `update public.projects set title = 'bob was here' where id = ${sqlLit(seed.projectA)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      // VIEWER: denied.
      await s().asUser(CAROL);
      await expect(
        s().denied(
          `update public.projects set title = 'carol was here' where id = ${sqlLit(seed.projectA)}`,
        ),
      ).resolves.toMatch(/0 rows/);
      await expect(
        s().denied(`delete from public.projects where id = ${sqlLit(seed.projectA)}`),
      ).resolves.toMatch(/0 rows/);
      // OUTSIDER: denied AND blind (0 rows, no existence leak).
      await s().asUser(BOB);
      await expect(
        s().denied(`delete from public.projects where id = ${sqlLit(seed.projectB)}`),
      ).resolves.toMatch(/0 rows/);
      // The cascade: deleting a project walks its memberships — INCLUDING
      // the creator's guarded owner row, which the depth carve-out passes —
      // without raising.
      await s().asUser(ALICE);
      await s().expectOk(`delete from public.projects where id = ${sqlLit(seed.projectB)}`);
      expect(await s().count(`select count(*) as n from public.projects`)).toBe(1);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [seed.datasetId]);
    }
  });

  test("project_invite_resolve: owner resolves emails; others raise; unknown email answers null", async () => {
    await beginAs(ALICE);
    const seed = await seedMatrix();
    try {
      // Case- and whitespace-insensitive; answers the profile id.
      const resolved = await s().expectOk(
        `select public.project_invite_resolve(${sqlLit(seed.projectA)}, '  CAROL@pg-int.test  ') as id`,
      );
      expect(String(firstRow(resolved).id)).toBe(CAROL);
      // Unknown email: null (the store surfaces "no account with that email").
      const unknown = await s().expectOk(
        `select public.project_invite_resolve(${sqlLit(seed.projectA)}, 'nobody@pg-int.test') as id`,
      );
      expect(firstRow(unknown).id).toBeNull();
      // EDITOR: the gate raises (the honest denial for a crafted call).
      await s().asUser(BOB);
      const editorError = await expectRaises(
        `select public.project_invite_resolve(${sqlLit(seed.projectA)}, 'carol@pg-int.test')`,
      );
      expect(editorError).toMatch(/does not manage this project/);
      // OUTSIDER: the same raise.
      const outsiderError = await expectRaises(
        `select public.project_invite_resolve(${sqlLit(seed.projectB)}, 'carol@pg-int.test')`,
      );
      expect(outsiderError).toMatch(/does not manage this project/);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [seed.datasetId]);
    }
  });

  test("invariants: every project has exactly one creator-owner row, born with the project", async () => {
    await beginAs(ALICE);
    const seed = await seedMatrix();
    try {
      // project A: 3 members; project B: 1. The owner rows are precisely
      // the (creator, role='owner') pairs — one per project, no more.
      const ownerRows = await s().expectOk(
        `select p.id, count(*) as n
         from public.projects p
         join public.project_members pm on pm.project_id = p.id and pm.role = 'owner' and pm.user_id = p.created_by
         group by p.id order by p.id`,
      );
      expect(ownerRows.length).toBe(2);
      for (const row of ownerRows) {
        expect(row.n).toBe("1");
      }
      // A project created WITHOUT an explicit created_by (the stamp fills
      // the invoker) still births its owner row — the store's create path.
      const stamped = crypto.randomUUID();
      await s().expectOk(
        `insert into public.projects (id, title) values (${sqlLit(stamped)}, 'stamped creator')`,
      );
      const stampedOwner = await s().expectOk(
        `select user_id::text as uid from public.project_members where project_id = ${sqlLit(stamped)}`,
      );
      expect(stampedOwner.length).toBe(1);
      expect(String(firstRow(stampedOwner).uid)).toBe(ALICE);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [seed.datasetId]);
    }
  });

  test("realtime publication carries projects + project_members (the 0018 join)", async () => {
    await s().asAdmin();
    // Two catalog lookups, sequentially on one wire session (the wire
    // client pipelines one statement at a time — the single-pipelining
    // lesson — so no Promise.all here).
    for (const table of ["projects", "project_members"]) {
      // oxlint-disable-next-line no-await-in-loop -- one wire session; statements must settle in order (the desync lesson).
      const rows = await s().expectOk(
        `select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = ${sqlLit(table)}`,
      );
      expect(rows.length, `${table} must join supabase_realtime`).toBe(1);
    }
  });
});
