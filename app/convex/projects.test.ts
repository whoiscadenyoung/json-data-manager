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
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

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
