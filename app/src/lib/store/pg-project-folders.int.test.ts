// Integration tests — project folders (migration 0034) against the local
// Supabase Postgres. Same wire-client pattern as the other pg-*.int.test.ts
// files: SQL spoken directly, roles switched inside a test-scoped
// transaction, everything rolled back. Skips when the stack is unreachable.
//
// The matrix:
//   * access — members read the tree, editors change it, viewers and
//     outsiders change nothing (and outsiders see nothing);
//   * tree integrity — sibling names are unique case-insensitively (root
//     included), a parent must be in the same project, a folder never moves
//     inside itself or a descendant;
//   * memberships — folder_id only names a folder of the same project;
//   * delete_project_folder — the folder goes, its subfolders and
//     memberships move up one level; a viewer's call answers 0.

import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
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

afterEach(async () => {
  if (session) await session.rollbackIfOpen();
});

/** Project A (ALICE owner, BOB editor, CAROL viewer) and project B (ALICE only), inside ALICE's transaction. */
async function seed(): Promise<{ projectA: string; projectB: string }> {
  await s().begin();
  await s().asUser(ALICE);
  const projectA = crypto.randomUUID(),
    projectB = crypto.randomUUID();
  await s().expectOk(
    `insert into public.projects (id, title, created_by) values
       (${sqlLit(projectA)}, 'folders A', ${sqlLit(ALICE)}),
       (${sqlLit(projectB)}, 'folders B', ${sqlLit(ALICE)})`,
  );
  await s().expectOk(
    `insert into public.project_members (project_id, user_id, role) values
       (${sqlLit(projectA)}, ${sqlLit(BOB)}, 'editor'),
       (${sqlLit(projectA)}, ${sqlLit(CAROL)}, 'viewer')`,
  );
  return { projectA, projectB };
}

async function addFolder(project: string, name: string, parent: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await s().expectOk(
    `insert into public.project_folders (id, project_id, parent_id, name)
     values (${sqlLit(id)}, ${sqlLit(project)}, ${parent === null ? "null" : sqlLit(parent)}, ${sqlLit(name)})`,
  );
  return id;
}

describe.skipIf(!dbUp())("project folders (0034)", () => {
  test("members read the tree; editors change it; viewers and outsiders change nothing", async () => {
    const { projectA, projectB } = await seed();
    const grants = await addFolder(projectA, "Grants", null);
    const foreign = await addFolder(projectB, "Private", null);

    // EDITOR (BOB): reads A's tree, creates and renames; B's tree is invisible.
    await s().asUser(BOB);
    expect(await s().count(`select count(*) as n from public.project_folders`)).toBe(1);
    await addFolder(projectA, "FY24", grants);
    expect(
      (
        await s().expectOk(
          `update public.project_folders set name = 'Grants 2' where id = ${sqlLit(grants)} returning id`,
        )
      ).length,
    ).toBe(1);
    await s().denied(
      `insert into public.project_folders (project_id, name) values (${sqlLit(projectB)}, 'Nope')`,
    );
    expect(
      (
        await s().expectOk(
          `update public.project_folders set name = 'Mine' where id = ${sqlLit(foreign)} returning id`,
        )
      ).length,
    ).toBe(0);

    // VIEWER (CAROL): reads; every write is refused or answers 0 rows.
    await s().asUser(CAROL);
    expect(await s().count(`select count(*) as n from public.project_folders`)).toBe(2);
    await s().denied(
      `insert into public.project_folders (project_id, name) values (${sqlLit(projectA)}, 'Viewer')`,
    );
    expect(
      (
        await s().expectOk(
          `delete from public.project_folders where id = ${sqlLit(grants)} returning id`,
        )
      ).length,
    ).toBe(0);
    expect(await s().count(`select public.delete_project_folder(${sqlLit(grants)}) as n`)).toBe(0);
    await s().rollback();
  });

  test("tree integrity: unique sibling names, same-project parents, no cycles", async () => {
    const { projectA, projectB } = await seed();
    const grants = await addFolder(projectA, "Grants", null);
    const fy24 = await addFolder(projectA, "FY24", grants);
    const deep = await addFolder(projectA, "Awards", fy24);
    const foreign = await addFolder(projectB, "Other", null);

    // Same name, same place (case-insensitive; the root counts as a place).
    expect(
      await s().denied(
        `insert into public.project_folders (project_id, name) values (${sqlLit(projectA)}, 'grants')`,
      ),
    ).toContain("project_folders_sibling_name");
    // The same name elsewhere is fine.
    await addFolder(projectA, "Grants", grants);

    expect(
      await s().denied(
        `insert into public.project_folders (project_id, parent_id, name)
         values (${sqlLit(projectA)}, ${sqlLit(foreign)}, 'Cross')`,
      ),
    ).toContain("not in this project");
    expect(
      await s().denied(
        `update public.project_folders set parent_id = ${sqlLit(deep)} where id = ${sqlLit(grants)}`,
      ),
    ).toContain("inside itself");
    expect(
      await s().denied(
        `update public.project_folders set parent_id = ${sqlLit(grants)} where id = ${sqlLit(grants)}`,
      ),
    ).toContain("inside itself");
    expect(
      await s().denied(
        `update public.project_folders set project_id = ${sqlLit(projectB)} where id = ${sqlLit(deep)}`,
      ),
    ).toContain("another project");
    // A legal move: Awards up to the root.
    await s().expectOk(
      `update public.project_folders set parent_id = null where id = ${sqlLit(deep)}`,
    );
    await s().rollback();
  });

  test("memberships sit only in their own project's folders; deleting a folder moves its contents up", async () => {
    const { projectA, projectB } = await seed();
    const dataset = await createDataset(s(), { createdBy: ALICE, lifecycle: "draft" });
    try {
      const grants = await addFolder(projectA, "Grants", null);
      const fy24 = await addFolder(projectA, "FY24", grants);
      const awards = await addFolder(projectA, "Awards", fy24);
      const foreign = await addFolder(projectB, "Other", null);
      const membership = crypto.randomUUID();
      await s().expectOk(
        `insert into public.project_artifacts (id, project_id, artifact_id, artifact_kind, role, sync_mode, folder_id)
         values (${sqlLit(membership)}, ${sqlLit(projectA)}, ${sqlLit(dataset)}, 'dataset', 'owned', 'manual', ${sqlLit(fy24)})`,
      );
      expect(
        await s().denied(
          `update public.project_artifacts set folder_id = ${sqlLit(foreign)} where id = ${sqlLit(membership)}`,
        ),
      ).toContain("not in this project");

      // EDITOR deletes FY24: Awards and the membership move up to Grants.
      await s().asUser(BOB);
      expect(await s().count(`select public.delete_project_folder(${sqlLit(fy24)}) as n`)).toBe(1);
      const moved = await s().expectOk(
        `select
           (select parent_id from public.project_folders where id = ${sqlLit(awards)}) as parent,
           (select folder_id from public.project_artifacts where id = ${sqlLit(membership)}) as folder,
           (select count(*) from public.project_folders where id = ${sqlLit(fy24)}) as gone`,
      );
      expect(moved[0]).toStrictEqual({ folder: grants, gone: "0", parent: grants });

      // Deleting a root folder leaves its contents at the root (null).
      expect(await s().count(`select public.delete_project_folder(${sqlLit(grants)}) as n`)).toBe(
        1,
      );
      expect(
        await s().count(
          `select count(*) as n from public.project_artifacts where id = ${sqlLit(membership)} and folder_id is null`,
        ),
      ).toBe(1);
      await s().rollback();
    } finally {
      await dropDatasets(s(), [dataset]);
    }
  });
});
