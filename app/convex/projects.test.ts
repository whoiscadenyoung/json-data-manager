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
    // All six functions ride the same auth choke point as their first line —
    // pinned per function, since each is its own public surface.
    const anonymous = initTest();
    await expect(anonymous.mutation(api.projects.create, { title: "Nope" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(anonymous.query(api.projects.list, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(anonymous.query(api.projects.get, { projectId: "whatever" })).rejects.toThrow(
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
    expect((await t.query(api.schemas.list, {})).map((row) => row._id)).not.toContain(draftId);
    expect((await t.query(api.schemas.listSummaries, {})).map((row) => row._id)).not.toContain(
      draftId,
    );
    expect((await t.query(api.schemas.listDraftSummaries, {})).map((row) => row._id)).toContain(
      draftId,
    );

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
    const beforePublished = (await t.query(api.schemas.list, {})).length;
    const beforeDrafts = (await t.query(api.schemas.listDraftSummaries, {})).length;

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
    expect((await t.query(api.schemas.list, {})).length).toBe(beforePublished);
    expect((await t.query(api.schemas.listDraftSummaries, {})).length).toBe(beforeDrafts);

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
    expect((await t.query(api.schemas.listSummaries, {})).map((row) => row._id)).toContain(
      publishedId,
    );
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
