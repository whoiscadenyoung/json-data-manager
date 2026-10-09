// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Projects as the working container (roadmap 7a, #102) — the issue's
 * acceptance criteria, driven through `api.projects.*` on a real (test)
 * backend (the publish.test.ts setup): the NEGATIVE case (a draft created in
 * a project is server-side filtered from every catalog read while its rows
 * stay real and resolvable through the seam), membership semantics
 * (references, not containment — adding a reference creates no catalog row),
 * creator-scoped reads, and the atomic birth of draft + membership row.
 *
 * Phase 2 of the project-workspace design adds the member-role suite: a
 * LINKED add (a published dataset, by its frozen row's id) pins its version
 * edge at the source chain's head — `syncMode: "auto"` floats it — the
 * workspace read projects the "update available" answer, Sync advances the
 * pin (editor members included, not the creator alone), and the link-XOR-
 * modify line refuses the sync surface on OWNED members.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const GATE_MESSAGE = /signed out/i;

/** A fresh test backend with the json-cms component mounted as in the app (the publish.test.ts shape). */
function initTest() {
  const t = convexTest(schema, modules);
  // Cast: `register` takes the component-generic `TestConvex` shape, while
  // `convexTest(schema, ...)` types `t` against this app's concrete schema —
  // the same instance, just nominal-type-invariant across the helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn(subject = "user-1") {
  return initTest().withIdentity({ subject });
}

type TestConvex = ReturnType<typeof signedIn>;
type Workspace = NonNullable<FunctionReturnType<typeof api.projects.get>>;
type Artifact = Workspace["artifacts"][number];

/** Creates a project through the public mutation. */
async function createProject(t: TestConvex, title = "SMART 2024"): Promise<Id<"projects">> {
  return t.mutation(api.projects.create, { title });
}

/** Inserts bare users-mirror rows so the invite lookup (by id or email) has something to answer with — the app-side table, exactly as the auth triggers would maintain it. */
async function seedUsers(t: TestConvex, entries: { authId: string; email: string }[]) {
  await t.run(async (ctx) => {
    for (const user of entries) {
      await ctx.db.insert("users", { authId: user.authId, email: user.email, emailVerified: true });
    }
  });
}

/** Invites `userId` into `projectId` with `role` — the owner-driven path the tests share. */
async function addMember(
  t: TestConvex,
  projectId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<Id<"projectMembers">> {
  return t.mutation(api.projects.addMember, { projectId, role, user: userId });
}

/** Creates a lifecycle-draft component dataset IN a project — the host-only path, through the new mutation. */
async function createProjectDraft(
  t: TestConvex,
  projectId: string,
  title = "Draft locations",
): Promise<string> {
  return t.mutation(api.projects.createDraftDataset, {
    projectId,
    schema: {
      properties: { label: { type: "string" } },
      title,
      type: "object",
    },
  });
}

/** Creates an ordinary PUBLISHED dataset through the pre-existing wrapper — which cannot set lifecycle, so absent reads as published. */
async function createPublishedDataset(t: TestConvex, title = "Published points"): Promise<string> {
  return t.mutation(api.schemas.create, {
    schema: { properties: { label: { type: "string" } }, title, type: "object" },
  });
}

/** The workspace read, narrowed — throws (failing the test with a clear name) when null. */
async function workspaceOf(t: TestConvex, projectId: string): Promise<Workspace> {
  const workspace = await t.query(api.projects.get, { projectId });
  if (workspace === null) {
    throw new Error("expected the creator's workspace read to be non-null");
  }
  return workspace;
}

/** The first artifact of a workspace read, narrowed — the tests always seed exactly the rows they assert on. */
function firstArtifact(workspace: Workspace): Artifact {
  const first = workspace.artifacts[0];
  if (first === undefined) {
    throw new Error("expected at least one artifact");
  }
  return first;
}

describe("projects: the working container (roadmap 7a, #102)", () => {
  it("rejects anonymous callers on every function and scopes the browser/workspace reads to the creator", async () => {
    // All functions ride the same auth choke point as their first line —
    // pinned per function, since each is its own public surface.
    const anonymous = initTest();
    await expect(anonymous.mutation(api.projects.create, { title: "Nope" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(anonymous.query(api.projects.list, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(anonymous.query(api.projects.get, { projectId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(anonymous.query(api.projects.members, { projectId: "whatever" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      anonymous.mutation(api.projects.createDraftDataset, {
        projectId: "whatever",
        schema: { title: "t" },
      }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.addArtifact, {
        artifactId: "whatever",
        artifactKind: "dataset",
        projectId: "whatever",
      }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.removeArtifact, {
        artifactId: "whatever",
        artifactKind: "dataset",
        projectId: "whatever",
      }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.update, { projectId: "whatever", title: "Nope" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.remove, { projectId: "whatever" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.addMember, {
        projectId: "whatever",
        role: "viewer",
        user: "user-2",
      }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.setRole, {
        projectId: "whatever",
        role: "editor",
        userId: "u",
      }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.removeMember, { projectId: "whatever", userId: "u" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projects.setMemberSync, {
        artifactId: "whatever",
        artifactKind: "dataset",
        projectId: "whatever",
        syncMode: "auto",
      }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.query(api.projects.holdingProjects, {
        artifactId: "whatever",
        artifactKind: "dataset",
      }),
    ).rejects.toThrow(GATE_MESSAGE);

    const mine = signedIn();
    const projectId = await mine.mutation(api.projects.create, {
      description: "The year's bundle",
      title: "SMART 2024",
    });
    // A draft, so the cross-user read below carries exactly the content the
    // acceptance criterion says must stay hidden.
    await createProjectDraft(mine, projectId);
    const listed = await mine.query(api.projects.list, {});
    expect(listed).toHaveLength(1);
    expect(listed[0] === undefined ? undefined : listed[0].title).toBe("SMART 2024");
    expect(listed[0] === undefined ? undefined : listed[0].artifactCount).toBe(1);
    expect(await mine.query(api.projects.get, { projectId })).not.toBeNull();

    // Another signed-in user on the SAME backend — a second initTest() would
    // build an empty database and the assertions would hold vacuously — so
    // `list`'s by_createdBy filter and `get`'s creator check run against real
    // data: user-2 sees no projects, and the workspace read answers null for
    // user-1's draft-carrying project.
    const other = mine.withIdentity({ subject: "user-2" });
    expect(await other.query(api.projects.list, {})).toHaveLength(0);
    expect(await other.query(api.projects.get, { projectId })).toBeNull();
  });

  it("lands create in the project: draft + membership born together, catalog reads exclude the draft (the negative case)", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const draftId = await createProjectDraft(t, projectId);

    // Born together: the draft is a REAL component dataset carrying the
    // host-only draft flag from creation...
    const draft = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: draftId }),
    );
    expect(draft === null ? undefined : draft.lifecycle).toBe("draft");
    // ...and its membership row exists — one transaction produced both.
    const workspace = await workspaceOf(t, projectId);
    expect(workspace.artifacts).toHaveLength(1);
    const membership = firstArtifact(workspace);
    expect(membership.artifactId).toBe(draftId);
    expect(membership.artifactKind).toBe("dataset");
    expect(workspace.project.artifactCount).toBe(1);

    // ...while EVERY catalog read excludes it server-side (the 5a filter,
    // pinned here against regressions — the acceptance case):
    expect((await t.query(api.schemas.list, { limit: 1000 })).map((row) => row._id)).not.toContain(
      draftId,
    );
    expect(
      (await t.query(api.schemas.listSummaries, { limit: 1000 })).map((row) => row._id),
    ).not.toContain(draftId);
    expect(
      (await t.query(api.schemas.listDraftSummaries, { limit: 1000 })).map((row) => row._id),
    ).toContain(draftId);

    // Draft rows are REAL rows: entries land through the ordinary wrapper
    // and resolve through the seam's entry-pages query, unchanged.
    await t.mutation(api.entries.create, { data: { label: "IG-1" }, schemaId: draftId });
    const page = await t.query(api.entries.listPage, {
      paginationOpts: { cursor: null, numItems: 10 },
      schemaId: draftId,
    });
    expect(page.page).toHaveLength(1);
  });

  it("keeps collections catalog-only: a filed published dataset lists, a project draft never does", async () => {
    const t = signedIn();
    const publishedId = await createPublishedDataset(t);
    const collectionId = await t.mutation(api.collections.create, { name: "SMART 2024" });
    await t.mutation(api.collections.addSchemaToCollection, {
      collectionId,
      schemaId: publishedId,
    });

    // Membership lives app-side only — creating a draft in a project never
    // files it into any collection.
    const projectId = await createProject(t);
    const draftId = await createProjectDraft(t, projectId);

    const listed = (await t.query(api.collections.listDatasets, { collectionId })).map(
      (row) => row._id,
    );
    expect(listed).toContain(publishedId);
    expect(listed).not.toContain(draftId);
  });

  it("adding a reference creates only a membership row — no catalog row, no copy", async () => {
    const t = signedIn();
    const publishedId = await createPublishedDataset(t);
    const projectId = await createProject(t);
    const beforePublished = (await t.query(api.schemas.list, { limit: 1000 })).length;
    const beforeDrafts = (await t.query(api.schemas.listDraftSummaries, { limit: 1000 })).length;

    const membershipId = await t.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });

    // Exactly one new row app-side, resolved to the live artifact; the
    // component catalog untouched — forking-as-reference creates no catalog
    // row.
    let workspace = await workspaceOf(t, projectId);
    expect(workspace.artifacts).toHaveLength(1);
    expect(firstArtifact(workspace)._id).toBe(membershipId);
    expect(firstArtifact(workspace).state.kind).toBe("dataset");
    expect(workspace.project.artifactCount).toBe(1);
    expect((await t.query(api.schemas.list, { limit: 1000 })).length).toBe(beforePublished);
    expect((await t.query(api.schemas.listDraftSummaries, { limit: 1000 })).length).toBe(
      beforeDrafts,
    );

    // A derived spec references by registry id; a map by component id —
    // both resolve through the same workspace read.
    const derivedId = await t.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: publishedId },
      status: "saved",
      title: "Join restaurants",
    });
    const mapId = await t.mutation(api.maps.create, { name: "SMART 2024 map" });
    await t.mutation(api.projects.addArtifact, {
      artifactId: derivedId,
      artifactKind: "derived",
      projectId,
    });
    await t.mutation(api.projects.addArtifact, {
      artifactId: mapId,
      artifactKind: "map",
      projectId,
    });
    workspace = await workspaceOf(t, projectId);
    expect(workspace.project.artifactCount).toBe(3);
    // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; .toSorted() isn't in the lib app/convex typechecks against (the publish.test.ts note).
    const kinds = workspace.artifacts.map((row) => row.state.kind).sort();
    expect(kinds).toEqual(["dataset", "derived", "map"]);

    // Duplicate adds land once (the in-transaction re-check — Convex has no
    // unique indexes).
    await expect(
      t.mutation(api.projects.addArtifact, {
        artifactId: publishedId,
        artifactKind: "dataset",
        projectId,
      }),
    ).rejects.toThrow(/already in this project/);

    // Unknown ids are rejected per kind — the reference must name something
    // real.
    await expect(
      t.mutation(api.projects.addArtifact, {
        artifactId: publishedId,
        artifactKind: "map",
        projectId,
      }),
    ).rejects.toThrow(/No map was found/);
    await expect(
      t.mutation(api.projects.addArtifact, {
        artifactId: "does-not-exist",
        artifactKind: "derived",
        projectId,
      }),
    ).rejects.toThrow(/No derived dataset/);
  });

  it("removeArtifact removes only the membership — the referenced artifact stays", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const publishedId = await createPublishedDataset(t);
    await t.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });

    await t.mutation(api.projects.removeArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });

    const workspace = await workspaceOf(t, projectId);
    expect(workspace.artifacts).toHaveLength(0);
    expect(workspace.project.artifactCount).toBe(0);
    // References, not containment: the dataset was never touched.
    expect(
      (await t.query(api.schemas.listSummaries, { limit: 1000 })).map((row) => row._id),
    ).toContain(publishedId);
  });

  it("answers a deleted artifact defensively in the workspace read", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const publishedId = await createPublishedDataset(t);
    await t.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });
    await t.mutation(api.schemas.remove, { schemaId: publishedId });

    const workspace = await workspaceOf(t, projectId);
    expect(workspace.artifacts).toHaveLength(1);
    expect(firstArtifact(workspace).state.kind).toBe("missing");
  });
});

const NO_ACCESS = /doesn't exist or you don't have access/i;
const GONE = /no longer exists/i;
const VIEW_ONLY = /view-only/i;

/**
 * The role access matrix (phase 1 of the project-workspace design, ADR 0011):
 * one project, four callers — owner (its creator), editor, viewer, and an
 * outsider who holds no row. Reads answer to every member; content writes
 * answer to editor-and-up; member management and deletion answer to the
 * owner alone; and the outsider's world is exactly the missing-project
 * answer everywhere, so an id's existence never leaks.
 */
describe("projects: collaboration — the role access matrix (ADR 0011)", () => {
  /** One backend, one project, one member per role — the matrix's fixture. */
  async function matrix() {
    const owner = signedIn("owner-1");
    const projectId = await owner.mutation(api.projects.create, { title: "Shared project" });
    // The users-mirror rows the invite lookup (id or email) answers through.
    await seedUsers(owner, [
      { authId: "editor-1", email: "editor@example.com" },
      { authId: "viewer-1", email: "viewer@example.com" },
    ]);
    await addMember(owner, projectId, "editor-1", "editor");
    await addMember(owner, projectId, "viewer-1", "viewer");
    return {
      projectId,
      owner,
      editor: owner.withIdentity({ subject: "editor-1" }),
      viewer: owner.withIdentity({ subject: "viewer-1" }),
      outsider: owner.withIdentity({ subject: "outsider-1" }),
    };
  }

  it("seats the creator as owner at create and answers the read matrix (owner/editor/viewer in, outsider out)", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    // The owner row is born WITH the project — one transaction produced both.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("projectMembers")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0] === undefined ? undefined : rows[0].role).toBe("owner");

    await seedUsers(t, [
      { authId: "user-2", email: "two@example.com" },
      { authId: "user-3", email: "three@example.com" },
    ]);
    await addMember(t, projectId, "user-2", "editor");
    await addMember(t, projectId, "user-3", "viewer");

    // `list` walks the caller's by_user membership rows and carries the
    // caller's own role: one project, three roles, three answers.
    const ownList = await t.query(api.projects.list, {});
    expect(ownList.map((row) => row.role)).toEqual(["owner"]);
    expect(
      (await t.withIdentity({ subject: "user-2" }).query(api.projects.list, {})).map((r) => r.role),
    ).toEqual(["editor"]);
    expect(
      (await t.withIdentity({ subject: "user-3" }).query(api.projects.list, {})).map((r) => r.role),
    ).toEqual(["viewer"]);
    expect(await t.withIdentity({ subject: "user-4" }).query(api.projects.list, {})).toHaveLength(
      0,
    );

    // The workspace read answers to every member and null to the outsider.
    expect(await t.query(api.projects.get, { projectId })).not.toBeNull();
    for (const subject of ["user-2", "user-3"]) {
      expect(
        await t.withIdentity({ subject }).query(api.projects.get, { projectId }),
      ).not.toBeNull();
    }
    expect(
      await t.withIdentity({ subject: "user-4" }).query(api.projects.get, { projectId }),
    ).toBeNull();
    // ...and the members read answers empty, not an error, to the outsider
    // (the read-null-vs-write-throw split, list-shaped).
    expect(
      await t.withIdentity({ subject: "user-4" }).query(api.projects.members, { projectId }),
    ).toEqual([]);
  });

  it("gates content writes at editor-and-up; viewer and outsider get the gone answer", async () => {
    const { projectId, owner, editor, viewer, outsider } = await matrix();

    // Owner and editor write content: drafts, references, project fields.
    const draftId = await editor.mutation(api.projects.createDraftDataset, {
      projectId,
      schema: { properties: { label: { type: "string" } }, title: "Editor draft", type: "object" },
    });
    expect(draftId).toBeTruthy();
    const publishedId = await owner.mutation(api.schemas.create, {
      schema: { properties: { label: { type: "string" } }, title: "Published", type: "object" },
    });
    await editor.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });
    await editor.mutation(api.projects.update, {
      description: "Reshaped by its editor",
      projectId,
    });
    expect((await workspaceOf(editor, projectId)).project.description).toBe(
      "Reshaped by its editor",
    );

    // Viewer and outsider: every content write is the same gone answer —
    // a project's existence never leaks through a denied write.
    for (const caller of [viewer, outsider]) {
      await expect(
        caller.mutation(api.projects.createDraftDataset, {
          projectId,
          schema: { title: "Nope", type: "object" },
        }),
      ).rejects.toThrow(GONE);
      await expect(
        caller.mutation(api.projects.addArtifact, {
          artifactId: publishedId,
          artifactKind: "dataset",
          projectId,
        }),
      ).rejects.toThrow(GONE);
      await expect(
        caller.mutation(api.projects.update, { projectId, title: "Nope" }),
      ).rejects.toThrow(GONE);
    }
    // The fork-as-spec leg rides the same guard.
    await expect(
      viewer.mutation(api.projects.forkAsSpec, {
        projectId,
        sourceDatasetId: publishedId,
        title: "Nope",
      }),
    ).rejects.toThrow(GONE);
  });

  it("answers member management to the owner alone, by id or by email, and never unseats the creator", async () => {
    const { projectId, owner, editor, viewer, outsider } = await matrix();
    await seedUsers(outsider, [
      { authId: "newcomer-1", email: "new@example.com" },
      { authId: "newcomer-2", email: "second@example.com" },
    ]);

    // Owner-only: editor, viewer, and outsider are all refused (the gone
    // answer — membership management is not a content write).
    for (const caller of [editor, viewer, outsider]) {
      await expect(
        caller.mutation(api.projects.addMember, {
          projectId,
          role: "editor",
          user: "newcomer-1",
        }),
      ).rejects.toThrow(GONE);
      await expect(
        caller.mutation(api.projects.setRole, { projectId, role: "viewer", userId: "editor-1" }),
      ).rejects.toThrow(GONE);
      await expect(
        caller.mutation(api.projects.removeMember, { projectId, userId: "viewer-1" }),
      ).rejects.toThrow(GONE);
    }

    // The invite resolves by Better Auth user id AND by email — one table,
    // two keys (users.ts's mirror-row lookup).
    const byEmail = await owner.mutation(api.projects.addMember, {
      projectId,
      role: "editor",
      user: "new@example.com",
    });
    const byId = await owner.mutation(api.projects.addMember, {
      projectId,
      role: "viewer",
      user: "newcomer-2",
    });
    expect(byEmail).not.toBeNull();
    expect(byId).not.toBeNull();
    // Unknown ids/emails are refused plainly.
    await expect(
      owner.mutation(api.projects.addMember, {
        projectId,
        role: "viewer",
        user: "ghost@example.com",
      }),
    ).rejects.toThrow(/No account was found/);
    // Duplicates land once — and the email invite already counts as the
    // same membership the id would name (one account, one row).
    await expect(
      owner.mutation(api.projects.addMember, {
        projectId,
        role: "viewer",
        user: "newcomer-1",
      }),
    ).rejects.toThrow(/already a member/);

    // Role changes apply — and the creator's row is refused for everything,
    // which is what keeps "a project always has an owner" true.
    await owner.mutation(api.projects.setRole, { projectId, role: "viewer", userId: "editor-1" });
    const members = await owner.query(api.projects.members, { projectId });
    const editorRow = members.find((row) => row.userId === "editor-1");
    expect(editorRow === undefined ? undefined : editorRow.role).toBe("viewer");
    await owner.mutation(api.projects.setRole, { projectId, role: "editor", userId: "editor-1" });
    await expect(
      owner.mutation(api.projects.setRole, { projectId, role: "viewer", userId: "owner-1" }),
    ).rejects.toThrow(/creator/);
    await expect(
      owner.mutation(api.projects.removeMember, { projectId, userId: "owner-1" }),
    ).rejects.toThrow(/creator/);
    // Removing a member who isn't one reads plainly, and removal revokes the
    // grant: the removed member's reads go outsider-shaped.
    await expect(
      owner.mutation(api.projects.removeMember, { projectId, userId: "stranger-1" }),
    ).rejects.toThrow(/isn't a member/);
    await owner.mutation(api.projects.removeMember, { projectId, userId: "newcomer-1" });
    expect(
      await owner.withIdentity({ subject: "newcomer-1" }).query(api.projects.list, {}),
    ).toHaveLength(0);
  });

  it("makes project-held drafts member-visible and member-editable — viewer read-only, outsider blind, catalog still excludes them", async () => {
    const { projectId, owner, editor, viewer, outsider } = await matrix();
    // The OWNER creates a draft in the project and puts a row in it.
    const draftId = await createProjectDraft(owner, projectId);
    await owner.mutation(api.entries.create, { data: { label: "IG-1" }, schemaId: draftId });

    // The workspace read resolves another member's draft (the by-ids pass —
    // not "missing").
    const editorView = await workspaceOf(editor, projectId);
    const draftArtifact = editorView.artifacts.find((row) => row.artifactId === draftId);
    expect(draftArtifact === undefined ? undefined : draftArtifact.state.kind).toBe("dataset");

    // Editor WRITES the project-held draft through the ordinary wrapper —
    // the choke point's project rule.
    await editor.mutation(api.entries.create, { data: { label: "IG-2" }, schemaId: draftId });
    const editorPage = await editor.query(api.entries.listPage, {
      paginationOpts: { cursor: null, numItems: 10 },
      schemaId: draftId,
    });
    expect(editorPage.page).toHaveLength(2);

    // Viewer READS the draft (by-id surfaces pass the visibility rule) and
    // never writes it (the view-only denial — the matrix's whole point).
    const viewerPage = await viewer.query(api.entries.listPage, {
      paginationOpts: { cursor: null, numItems: 10 },
      schemaId: draftId,
    });
    expect(viewerPage.page).toHaveLength(2);
    await expect(
      viewer.mutation(api.entries.create, { data: { label: "Nope" }, schemaId: draftId }),
    ).rejects.toThrow(VIEW_ONLY);

    // Outsider: blind everywhere — by-id reads deny like a missing row, and
    // the workspace read is null.
    await expect(outsider.query(api.schemas.get, { schemaId: draftId })).rejects.toThrow(NO_ACCESS);
    await expect(
      outsider.mutation(api.entries.create, { data: { label: "Nope" }, schemaId: draftId }),
    ).rejects.toThrow(NO_ACCESS);

    // The catalog never widens: enumeration reads stay component-scoped by
    // viewerId, so the owner's draft appears in NO member's catalog or
    // drafts toggle — only in the workspace.
    for (const caller of [editor, viewer]) {
      expect(
        (await caller.query(api.schemas.list, { limit: 1000 })).map((row) => row._id),
      ).not.toContain(draftId);
      expect(
        (await caller.query(api.schemas.listSummaries, { limit: 1000 })).map((row) => row._id),
      ).not.toContain(draftId);
      expect(
        (await caller.query(api.schemas.listDraftSummaries, { limit: 1000 })).map((row) => row._id),
      ).not.toContain(draftId);
    }
    expect(
      (await owner.query(api.schemas.listDraftSummaries, { limit: 1000 })).map((row) => row._id),
    ).toContain(draftId);
  });

  it("deletes owner-only and cascades the grants and reference edges — never the artifacts", async () => {
    const { projectId, owner, editor } = await matrix();
    const publishedId = await createPublishedDataset(owner);
    await editor.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });

    // Owner-only.
    await expect(editor.mutation(api.projects.remove, { projectId })).rejects.toThrow(GONE);
    await owner.mutation(api.projects.remove, { projectId });

    // The membership rows, the member rows, and the fork's reference edge
    // are gone — one transaction, no orphans.
    expect(await owner.query(api.projects.list, {})).toHaveLength(0);
    expect(await editor.query(api.projects.list, {})).toHaveLength(0);
    expect(await owner.query(api.projects.get, { projectId })).toBeNull();
    const leftovers = await owner.run(async (ctx) => ({
      memberships: await ctx.db
        .query("projectArtifacts")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
      members: await ctx.db
        .query("projectMembers")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
      edges: await ctx.db
        .query("consumerReferences")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", publishedId))
        .collect(),
    }));
    expect(leftovers.memberships).toHaveLength(0);
    expect(leftovers.members).toHaveLength(0);
    expect(leftovers.edges).toHaveLength(0);

    // References, not containment: the referenced dataset is untouched.
    expect(
      (await owner.query(api.schemas.listSummaries, { limit: 1000 })).map((row) => row._id),
    ).toContain(publishedId);
  });

  it("lets an editor press the project's bundle and read its plan — viewer and outsider get the gone answer", async () => {
    const { projectId, owner, editor, viewer, outsider } = await matrix();
    // A map with one dataset layer, so the press has something to publish —
    // the bundles.test.ts shape, kept minimal.
    const publishedId = await createPublishedDataset(owner);
    const mapId = await owner.mutation(api.maps.create, { name: "Shared map" });
    await owner.mutation(api.maps.addLayer, {
      mapId,
      targetId: publishedId,
      targetType: "dataset",
    });
    await editor.mutation(api.projects.addArtifact, {
      artifactId: mapId,
      artifactKind: "map",
      projectId,
    });
    await editor.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });

    // Reads answer to every member (the plan names the drafts).
    expect(await editor.query(api.bundles.plan, { projectId })).not.toBeNull();
    expect(await viewer.query(api.bundles.plan, { projectId })).not.toBeNull();
    expect(await outsider.query(api.bundles.plan, { projectId })).toBeNull();

    // Writes answer to editor-and-up.
    const started = await editor.mutation(api.bundles.start, { projectId });
    expect(started.joined).toBe(false);
    await expect(viewer.mutation(api.bundles.start, { projectId })).rejects.toThrow(
      /no longer exists/i,
    );
    await expect(outsider.mutation(api.bundles.start, { projectId })).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it("plans every held draft from the editor's seat and answers publish.start to the seat, not the creator stamp", async () => {
    const { projectId, owner, editor, viewer, outsider } = await matrix();
    const publishedId = await createPublishedDataset(owner);
    await owner.mutation(api.entries.create, { data: { label: "S-1" }, schemaId: publishedId });
    const ownerDraftId = await createProjectDraft(owner, projectId, "Owner draft");
    const forkId = await owner.mutation(api.projects.forkAsSpec, {
      projectId,
      sourceDatasetId: publishedId,
      title: "Owner fork",
    });
    const editorDraftId = await editor.mutation(api.projects.createDraftDataset, {
      projectId,
      schema: { properties: { label: { type: "string" } }, title: "Editor draft", type: "object" },
    });

    // The editor's plan resolves every held draft — the editor-created one
    // never entered the identity-scoped reads (they run with the project
    // creator's viewerId) and used to drop out as "no longer exists".
    const plan = await editor.query(api.bundles.plan, { projectId });
    const keys = plan === null ? [] : plan.members.map((member) => member.datasetKey);
    expect(keys).toContain(ownerDraftId);
    expect(keys).toContain(editorDraftId);
    expect(keys).toContain(forkId);

    // publish.start answers to the seat: the editor can start the publish
    // for members they did not create personally — the exact failure the
    // old creator-only resolution caused for every non-editor-created
    // member of an editor's press.
    await editor.mutation(api.publish.start, { datasetKey: ownerDraftId });
    await editor.mutation(api.publish.start, { datasetKey: forkId });

    // Everyone below editor still reads the held draft as absent here.
    await expect(viewer.mutation(api.publish.start, { datasetKey: ownerDraftId })).rejects.toThrow(
      /Nothing to publish/,
    );
    await expect(
      outsider.mutation(api.publish.start, { datasetKey: ownerDraftId }),
    ).rejects.toThrow(/Nothing to publish/);

    // The draft leg's leak stays closed (ADR 0011 review, finding 3): a
    // foreign row that is NOT a draft denies with the not-found shape —
    // whoever asks, however visible or shared the row is. First the exact
    // probe the review ran: an OUTSIDER against an ordinary published row
    // that the same outsider's schemas.get denies as absent…
    await expect(outsider.mutation(api.publish.start, { datasetKey: publishedId })).rejects.toThrow(
      /Nothing to publish/,
    );
    // …then its author-restricted twin.
    const restrictedId = await createPublishedDataset(owner, "Restricted");
    await owner.mutation(api.schemas.setVisibility, {
      schemaId: restrictedId,
      visibility: "author",
    });
    await expect(
      outsider.mutation(api.publish.start, { datasetKey: restrictedId }),
    ).rejects.toThrow(/Nothing to publish/);
    // Shared into the project, an already-published member is still not
    // re-publishable through this path — and still reads as absent to the
    // editor's seat check. The routing message ("Only a draft dataset…")
    // stays the creator's alone.
    await editor.mutation(api.projects.addArtifact, {
      artifactId: publishedId,
      artifactKind: "dataset",
      projectId,
    });
    await expect(editor.mutation(api.publish.start, { datasetKey: publishedId })).rejects.toThrow(
      /Nothing to publish/,
    );
    await expect(owner.mutation(api.publish.start, { datasetKey: publishedId })).rejects.toThrow(
      /Only a draft dataset can be published/,
    );
    // The registry leg's shape, pinned too: a foreign builder autosave
    // (never saved, never shared) reads as absent.
    const autosaveId = await editor.mutation(api.derivedDatasets.save, {
      spec: { operations: [], sourceDatasetId: publishedId },
      status: "draft",
      title: "Editor autosave",
    });
    await expect(outsider.mutation(api.publish.start, { datasetKey: autosaveId })).rejects.toThrow(
      /Nothing to publish/,
    );

    // And ADR 0010 rides through the press path unchanged: a locked draft
    // answers every write — publish included — to its creator alone.
    await owner.mutation(api.schemas.setEditPolicy, {
      editPolicy: "locked",
      schemaId: ownerDraftId,
    });
    await expect(editor.mutation(api.publish.start, { datasetKey: ownerDraftId })).rejects.toThrow(
      /Nothing to publish/,
    );
  });
});

// ---------------------------------------------------------------------------
// Member roles and pin/sync (phase 2 of the project-workspace design): the
// linked-add pin, the auto float, the update-available projection, per-member
// Sync/Revert, and the link-XOR-modify guard.
// ---------------------------------------------------------------------------

/** Runs every scheduled function — the publish poller and its completion hook — to completion (the consumption.test.ts shape). */
async function drainScheduled(t: TestConvex): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** One chunk blob, planted in the COMPONENT's storage (the consumption.test.ts helper), plus its pending-upload token (issued for the attempt). */
async function storeChunk(t: TestConvex, attemptId: string, rows: Array<{ data: unknown }>) {
  const bytes = new TextEncoder().encode(JSON.stringify(rows)),
    storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
      bytes: bytes.buffer,
    }),
    { uploadId } = await t.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.generateUploadUrl, { scope: attemptId }),
    );
  return { storageId, uploadId };
}

/** Drives one full publish: plan → register → freeze → drain (the consumption.test.ts shape). */
async function drivePublish(
  t: TestConvex,
  options: {
    attemptId: FunctionReturnType<typeof api.publish.start>["attemptId"];
    chunks: Array<Array<{ data: unknown }>>;
    totalRows: number;
  },
): Promise<{ schemaId: string }> {
  await t.mutation(api.publish.plan, {
    attemptId: options.attemptId,
    chunkCount: options.chunks.length,
    totalRows: options.totalRows,
  });
  for (const chunk of options.chunks) {
    // oxlint-disable-next-line no-await-in-loop -- order is the resume index.
    const { storageId, uploadId } = await storeChunk(t, options.attemptId, chunk);
    // oxlint-disable-next-line no-await-in-loop -- order is the resume index.
    await t.mutation(api.publish.registerChunk, {
      attemptId: options.attemptId,
      rowCount: chunk.length,
      storageId,
      uploadId,
    });
  }
  const frozen = await t.mutation(api.publish.freeze, { attemptId: options.attemptId });
  await drainScheduled(t);
  return { schemaId: frozen.schemaId };
}

/** Publishes a draft's current rows as its next version (start → drive) — the consumption.test.ts helper, reshaped for this file's fixtures. */
async function publishDraft(
  t: TestConvex,
  draftId: string,
  rows: Array<{ data: Record<string, unknown> }>,
): Promise<{ schemaId: string }> {
  const started = await t.mutation(api.publish.start, { datasetKey: draftId });
  return drivePublish(t, {
    attemptId: started.attemptId,
    chunks: rows.length === 0 ? [] : [rows],
    totalRows: rows.length,
  });
}

/** Creates a lifecycle-draft component dataset OUTSIDE any project — the host-only path (the consumption.test.ts shape): the source a linked member references. */
async function createStandaloneDraft(t: TestConvex, title = "Source locations"): Promise<string> {
  return t.run(async (ctx) =>
    ctx.runMutation(components.jsonCms.lib.createSchema, {
      actorId: "user-1",
      lifecycle: "draft",
      schema: { properties: { label: { type: "string" } }, title, type: "object" },
    }),
  );
}

/** The frozen row's global snapshot ref — the pin identity (the consumption.test.ts refOf shape). */
function refOf(doc: { lineage?: { snapshotRef?: string } } | null): string | undefined {
  return doc === null || doc.lineage === undefined ? undefined : doc.lineage.snapshotRef;
}

/** The membership row the workspace read names for one artifact, narrowed. */
function artifactOf(workspace: Workspace, artifactId: string): Artifact {
  const match = workspace.artifacts.find((row) => row.artifactId === artifactId);
  if (match === undefined) {
    throw new Error(`expected the workspace to hold ${artifactId}`);
  }
  return match;
}

/** One linked member's sync projection, narrowed — the house lint bans optional chaining (the consumption.test.ts `defined` shape). */
function syncStateOf(artifact: Artifact): NonNullable<Artifact["sync"]> {
  const sync = artifact.sync;
  if (sync === undefined) {
    throw new Error("expected this linked member to carry sync state");
  }
  return sync;
}

describe("projects: member roles and pin/sync (phase 2 of the project-workspace design)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The suite's fixture: one project, one published source chain (v1 frozen),
   * the frozen row added to the project as a LINKED member, plus an in-project
   * draft (OWNED). Returns everything the sync tests assert through.
   */
  async function linkedFixture(t: TestConvex) {
    const projectId = await createProject(t, "Sync project");
    const draftId = await createStandaloneDraft(t);
    await t.mutation(api.entries.create, { data: { label: "A" }, schemaId: draftId });
    const v1 = await publishDraft(t, draftId, [{ data: { label: "A" } }]);
    await t.mutation(api.projects.addArtifact, {
      artifactId: v1.schemaId,
      artifactKind: "dataset",
      projectId,
    });
    const ownedId = await createProjectDraft(t, projectId, "Owned draft");
    const v1Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v1.schemaId }),
    );
    return { draftId, linkedId: v1.schemaId, ownedId, projectId, v1Ref: refOf(v1Head) };
  }

  it("lands a linked add pinned at the source's head, badges the drift, and Sync — by any editor, not the creator alone — advances the pin", async () => {
    const t = signedIn("user-1");
    const { draftId, linkedId, projectId, v1Ref } = await linkedFixture(t);

    // The linked member: role linked, sync manual (the default), edge pinned
    // at v1 — the design's "a linked add mints a pin edge at head".
    let linked = artifactOf(await workspaceOf(t, projectId), linkedId);
    expect(linked.role).toBe("linked");
    expect(linked.syncMode).toBe("manual");
    let sync = syncStateOf(linked);
    expect(sync.mode).toBe("pin");
    expect(sync.upToDate).toBe(true);
    expect(sync.pinnedRef).toBe(v1Ref);

    // The source republishes → v2: the workspace read badges "update
    // available" (upToDate false), naming the new head.
    const v2 = await publishDraft(t, draftId, [{ data: { label: "A" } }, { data: { label: "B" } }]);
    linked = artifactOf(await workspaceOf(t, projectId), linkedId);
    sync = syncStateOf(linked);
    expect(sync.upToDate).toBe(false);
    expect(sync.headVersionLabel).toBe("v2");
    const v2Head = await t.run(async (ctx) =>
      ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId: v2.schemaId }),
    );

    // Sync by a NON-creator editor — the per-member half of the feature (the
    // pre-phase-2 guard answered to the project's creator alone).
    await seedUsers(t, [{ authId: "editor-1", email: "editor@example.com" }]);
    await addMember(t, projectId, "editor-1", "editor");
    const editor = t.withIdentity({ subject: "editor-1" });
    const synced = await editor.mutation(api.consumption.syncReference, {
      referenceId: sync.referenceId,
    });
    expect(synced.mode).toBe("pin");
    linked = artifactOf(await workspaceOf(t, projectId), linkedId);
    sync = syncStateOf(linked);
    expect(sync.upToDate).toBe(true);
    expect(sync.pinnedRef).toBe(refOf(v2Head));

    // A viewer-role member reads the state and never writes it — the honest
    // view-only denial (they can see the workspace; ADR 0011's denial rule).
    await seedUsers(t, [{ authId: "viewer-1", email: "viewer@example.com" }]);
    await addMember(t, projectId, "viewer-1", "viewer");
    const viewer = t.withIdentity({ subject: "viewer-1" });
    await expect(
      viewer.mutation(api.consumption.syncReference, { referenceId: sync.referenceId }),
    ).rejects.toThrow(/view-only/i);
    // ...and an outsider reads the edge as gone (the stage-8 denial shape).
    await expect(
      t
        .withIdentity({ subject: "outsider-1" })
        .mutation(api.consumption.syncReference, { referenceId: sync.referenceId }),
    ).rejects.toThrow(/no longer exists/i);
  });

  it("floats an auto add and drives the per-member keep-in-sync flip through setMemberSync", async () => {
    const t = signedIn("user-1");
    const projectId = await createProject(t, "Auto project");
    const draftId = await createStandaloneDraft(t, "Auto source");
    await t.mutation(api.entries.create, { data: { label: "A" }, schemaId: draftId });
    const v1 = await publishDraft(t, draftId, [{ data: { label: "A" } }]);

    // auto = float: the edge is born floating and stays current through a
    // republish — no badge, no sync needed.
    await t.mutation(api.projects.addArtifact, {
      artifactId: v1.schemaId,
      artifactKind: "dataset",
      projectId,
      syncMode: "auto",
    });
    let linked = artifactOf(await workspaceOf(t, projectId), v1.schemaId);
    expect(linked.role).toBe("linked");
    expect(linked.syncMode).toBe("auto");
    let sync = syncStateOf(linked);
    expect(sync.mode).toBe("float");
    expect(sync.upToDate).toBe(true);
    await publishDraft(t, draftId, [{ data: { label: "A" } }, { data: { label: "B" } }]);
    linked = artifactOf(await workspaceOf(t, projectId), v1.schemaId);
    expect(syncStateOf(linked).upToDate).toBe(true);

    // Flip to manual: pin at the CURRENT head ("stop following, freeze where
    // we are") — afterwards a republish badges again.
    await t.mutation(api.projects.setMemberSync, {
      artifactId: v1.schemaId,
      artifactKind: "dataset",
      projectId,
      syncMode: "manual",
    });
    linked = artifactOf(await workspaceOf(t, projectId), v1.schemaId);
    expect(linked.syncMode).toBe("manual");
    sync = syncStateOf(linked);
    expect(sync.mode).toBe("pin");
    expect(sync.upToDate).toBe(true);
    await publishDraft(t, draftId, [{ data: { label: "A" } }, { data: { label: "C" } }]);
    linked = artifactOf(await workspaceOf(t, projectId), v1.schemaId);
    expect(syncStateOf(linked).upToDate).toBe(false);

    // And back to auto: the pin dissolves into a float, current again.
    await t.mutation(api.projects.setMemberSync, {
      artifactId: v1.schemaId,
      artifactKind: "dataset",
      projectId,
      syncMode: "auto",
    });
    linked = artifactOf(await workspaceOf(t, projectId), v1.schemaId);
    expect(linked.syncMode).toBe("auto");
    sync = syncStateOf(linked);
    expect(sync.mode).toBe("float");
    expect(sync.upToDate).toBe(true);
  });

  it("enforces link XOR modify: owned members refuse the sync surface, drafts land owned, and maps are refused", async () => {
    const t = signedIn("user-1");
    const { linkedId, ownedId, projectId } = await linkedFixture(t);

    // An in-project draft is OWNED — the modify side. setMemberSync refuses
    // it: an owned member is edited in place, never pinned/synced.
    const owned = artifactOf(await workspaceOf(t, projectId), ownedId);
    expect(owned.role).toBe("owned");
    await expect(
      t.mutation(api.projects.setMemberSync, {
        artifactId: ownedId,
        artifactKind: "dataset",
        projectId,
        syncMode: "auto",
      }),
    ).rejects.toThrow(/Owned members are edited in place/);

    // The other owned path: adding a DRAFT by reference (a creator pulling
    // their own WIP in) lands owned too — ADR 0011's member-editable line —
    // and carries no sync state to badge.
    const wipId = await createStandaloneDraft(t, "WIP pulled in");
    await t.mutation(api.projects.addArtifact, {
      artifactId: wipId,
      artifactKind: "dataset",
      projectId,
    });
    const wip = artifactOf(await workspaceOf(t, projectId), wipId);
    expect(wip.role).toBe("owned");
    expect(wip.sync).toBeUndefined();
    await expect(
      t.mutation(api.projects.setMemberSync, {
        artifactId: wipId,
        artifactKind: "dataset",
        projectId,
        syncMode: "manual",
      }),
    ).rejects.toThrow(/Owned members are edited in place/);

    // Maps hold no version chain — the sync surface refuses them too.
    const mapId = await t.mutation(api.maps.create, { name: "Sync project map" });
    await t.mutation(api.projects.addArtifact, {
      artifactId: mapId,
      artifactKind: "map",
      projectId,
    });
    await expect(
      t.mutation(api.projects.setMemberSync, {
        artifactId: mapId,
        artifactKind: "map",
        projectId,
        syncMode: "auto",
      }),
    ).rejects.toThrow(/Maps don't carry version chains/);

    // Not a member of this project: the artifact isn't in it, plain answer.
    await expect(
      t.mutation(api.projects.setMemberSync, {
        artifactId: linkedId,
        artifactKind: "dataset",
        projectId: await createProject(t, "Other project"),
        syncMode: "auto",
      }),
    ).rejects.toThrow(/isn't in this project/);
  });

  it("answers holdingProjects with the caller's own member projects only", async () => {
    const t = signedIn("user-1");
    const projectId = await createProject(t, "Holder");
    const { linkedId } = await linkedFixture(t);
    // linkedFixture created its own project; this one gets a direct member.
    const draftId = await createStandaloneDraft(t, "Held source");
    await t.mutation(api.entries.create, { data: { label: "A" }, schemaId: draftId });
    const v1 = await publishDraft(t, draftId, [{ data: { label: "A" } }]);
    await t.mutation(api.projects.addArtifact, {
      artifactId: v1.schemaId,
      artifactKind: "dataset",
      projectId,
    });

    expect(
      await t.query(api.projects.holdingProjects, {
        artifactId: v1.schemaId,
        artifactKind: "dataset",
      }),
    ).toEqual([projectId]);
    // A project the caller holds no role in contributes nothing — another
    // user's workspace never leaks through a dataset they can see.
    const other = t.withIdentity({ subject: "someone-else" });
    expect(
      await other.query(api.projects.holdingProjects, {
        artifactId: v1.schemaId,
        artifactKind: "dataset",
      }),
    ).toEqual([]);
    // Both linked members answer with their own holders.
    expect(
      await t.query(api.projects.holdingProjects, {
        artifactId: linkedId,
        artifactKind: "dataset",
      }),
    ).toHaveLength(1);
  });
});
