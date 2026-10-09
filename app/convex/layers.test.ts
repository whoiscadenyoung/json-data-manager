// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Layers (phase 3 of the project-workspace design, ADR 0012) — driven through
 * `api.layers.*` on a real (test) backend, the projects.test.ts conventions:
 * the role access matrix (owner/editor/viewer/outsider), the membership birth
 * of a layer (row + projectArtifacts in one transaction), link (published →
 * pinned read-only member), clone (published → owned draft, deep for groups),
 * the group ops with their cycle guard, and the schema-drift stamp
 * (sync → needsAttention, the next styling write clears it).
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
const GONE = /no longer exists/i;

/** A fresh test backend with the json-cms component mounted as in the app (the projects.test.ts shape). */
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
type LayerDetail = NonNullable<FunctionReturnType<typeof api.layers.get>>;

/** Creates a project through the public mutation. */
async function createProject(t: TestConvex, title = "Layer home"): Promise<Id<"projects">> {
  return t.mutation(api.projects.create, { title });
}

/** Adds a member with `role` (the owner-driven invite path). */
async function addMember(
  t: TestConvex,
  projectId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<void> {
  await t.mutation(api.projects.addMember, { projectId, role, user: userId });
}

/** An ordinary PUBLISHED geospatial dataset (absent lifecycle reads as published). */
async function createGeospatialDataset(t: TestConvex, title = "Points"): Promise<string> {
  return t.mutation(api.schemas.create, {
    geometryType: "Point",
    kind: "geospatial",
    schema: { properties: { label: { type: "string" } }, title, type: "object" },
  });
}

/** Creates a data layer over a dataset, joining the dataset to the project first when it isn't a member yet (the sheets' two-step; already-member reuses the row, the addArtifact semantics). */
async function createDataLayer(
  t: TestConvex,
  projectId: string,
  datasetId: string,
  name = "Points layer",
): Promise<Id<"layers">> {
  const workspace = await t.query(api.projects.get, { projectId });
  const existing =
    workspace === null
      ? undefined
      : workspace.artifacts.find(
          (row) => row.artifactKind === "dataset" && row.artifactId === datasetId,
        );
  const membershipId =
    existing === undefined
      ? await t.mutation(api.projects.addArtifact, {
          artifactId: datasetId,
          artifactKind: "dataset",
          projectId,
        })
      : existing._id;
  return t.mutation(api.layers.create, {
    datasetMemberId: membershipId,
    kind: "data",
    name,
    projectId,
  });
}

/** The layer read, narrowed — throws (failing the test with a clear name) when null. */
async function layerOf(t: TestConvex, layerId: string): Promise<LayerDetail> {
  const layer = await t.query(api.layers.get, { layerId });
  if (layer === null) {
    throw new Error("expected the layer read to be non-null");
  }
  return layer;
}

/** Seeds one frozen version row for `layerId` — phase 5's publish will mint these through the real flow; the phase-3 link/clone gates read the chain's existence directly. */
async function seedVersion(
  t: TestConvex,
  layerId: string,
  definition: Record<string, unknown>,
  options: {
    dataset?: {
      pinnedRef?: string;
      pinnedSchemaId?: string;
      sourceMemberId: string;
    };
    frozenChildren?: Array<{
      childKind: "linked" | "owned";
      childLayerId: string;
      versionId?: string;
    }>;
    versionLabel?: string;
  } = {},
): Promise<Id<"layerVersions">> {
  return t.run(async (ctx) => {
    const id = ctx.db.normalizeId("layers", layerId);
    if (id === null) {
      throw new Error("expected a well-formed layer id");
    }
    let dataset:
      | {
          pinnedRef?: string;
          pinnedSchemaId?: string;
          sourceMemberId: Id<"projectArtifacts">;
        }
      | undefined;
    if (options.dataset !== undefined) {
      const memberId = ctx.db.normalizeId("projectArtifacts", options.dataset.sourceMemberId);
      if (memberId === null) {
        throw new Error("expected a well-formed membership id");
      }
      dataset = { ...options.dataset, sourceMemberId: memberId };
    }
    return ctx.db.insert("layerVersions", {
      dataset,
      definition,
      frozenChildren: options.frozenChildren,
      frozenAt: Date.now(),
      layerId: id,
      versionLabel: options.versionLabel ?? "v1",
    });
  });
}

describe("layers: the role access matrix and the gate (ADR 0012)", () => {
  it("rejects anonymous callers on every function", async () => {
    const anonymous = initTest();
    await expect(anonymous.query(api.layers.list, { projectId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(anonymous.query(api.layers.get, { layerId: "x" })).rejects.toThrow(GATE_MESSAGE);
    await expect(anonymous.query(api.layers.versions, { layerId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      anonymous.mutation(api.layers.create, { kind: "group", name: "Nope", projectId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.layers.update, { layerId: "x", name: "Nope" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.layers.setVisible, { layerId: "x", visible: false }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(anonymous.mutation(api.layers.remove, { layerId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      anonymous.mutation(api.layers.link, { layerId: "x", projectId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.layers.clone, { layerId: "x", projectId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.layers.addToGroup, { groupId: "x", layerId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.layers.removeFromGroup, { groupId: "x", layerId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(anonymous.mutation(api.layers.reparent, { layerId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      anonymous.mutation(api.layers.reorder, { direction: "up", groupId: "x", layerId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
  });

  it("seats writes at editor-and-up of the owning project; viewer and outsider get the gone answer; reads answer to any member only", async () => {
    const owner = signedIn("owner-1");
    const projectId = await createProject(owner);
    await owner.run(async (ctx) => {
      for (const [authId, email] of [
        ["editor-1", "editor@example.com"],
        ["viewer-1", "viewer@example.com"],
      ]) {
        await ctx.db.insert("users", { authId, email, emailVerified: true });
      }
    });
    await addMember(owner, projectId, "editor-1", "editor");
    await addMember(owner, projectId, "viewer-1", "viewer");
    const editor = owner.withIdentity({ subject: "editor-1" }),
      viewer = owner.withIdentity({ subject: "viewer-1" }),
      outsider = owner.withIdentity({ subject: "outsider-1" });

    const layerId = await editor.mutation(api.layers.create, {
      kind: "group",
      name: "Editor's group",
      projectId,
    });
    expect(layerId).toBeTruthy();

    // Reads answer to every member — and to nobody else (list empty, get null).
    expect(await viewer.query(api.layers.get, { layerId })).not.toBeNull();
    expect((await viewer.query(api.layers.list, { projectId })).map((row) => row._id)).toContain(
      layerId,
    );
    expect(await outsider.query(api.layers.get, { layerId })).toBeNull();
    expect(await outsider.query(api.layers.list, { projectId })).toEqual([]);

    // Writes answer to editor-and-up; viewer and outsider read the gone
    // answer — the same one a missing layer gives (an id's existence never
    // leaks through a denied write).
    for (const caller of [viewer, outsider]) {
      await expect(
        caller.mutation(api.layers.create, { kind: "group", name: "Nope", projectId }),
      ).rejects.toThrow(GONE);
      await expect(caller.mutation(api.layers.update, { layerId, name: "Nope" })).rejects.toThrow(
        GONE,
      );
      await expect(
        caller.mutation(api.layers.setVisible, { layerId, visible: false }),
      ).rejects.toThrow(GONE);
      await expect(caller.mutation(api.layers.remove, { layerId })).rejects.toThrow(GONE);
      await expect(caller.mutation(api.layers.link, { layerId, projectId })).rejects.toThrow(GONE);
      await expect(caller.mutation(api.layers.clone, { layerId, projectId })).rejects.toThrow(GONE);
      await expect(
        caller.mutation(api.layers.addToGroup, { groupId: layerId, layerId }),
      ).rejects.toThrow(GONE);
    }

    // The editor writes the owner's layer (the ADR 0011 seat, not a creator
    // stamp): restyle, visibility, grouping.
    await editor.mutation(api.layers.update, { layerId, name: "Renamed by editor" });
    expect((await layerOf(editor, layerId)).name).toBe("Renamed by editor");
    await editor.mutation(api.layers.setVisible, { layerId, visible: false });
    expect((await layerOf(editor, layerId)).visible).toBe(false);
  });
});

describe("layers: creation and the membership birth", () => {
  it("creates a data layer born with its membership — workspace-visible through projects.get", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const datasetId = await t.mutation(api.schemas.create, {
      schema: { properties: { label: { type: "string" } }, title: "Points", type: "object" },
    });
    const membershipId = await t.mutation(api.projects.addArtifact, {
      artifactId: datasetId,
      artifactKind: "dataset",
      projectId,
    });
    const layerId = await t.mutation(api.layers.create, {
      datasetMemberId: membershipId,
      kind: "data",
      name: "Points layer",
      projectId,
      style: { color: "#3b82f6" },
    });

    // The layer row + its membership row exist together.
    const detail = await layerOf(t, layerId);
    expect(detail.kind).toBe("data");
    expect(detail.datasetMemberId).toBe(membershipId);
    expect(detail.lifecycle).toBe("draft");
    expect(detail.membershipId).not.toBeUndefined();
    const workspace = await t.query(api.projects.get, { projectId });
    const layerArtifact =
      workspace === null
        ? undefined
        : workspace.artifacts.find((row) => row.artifactId === layerId);
    expect(layerArtifact === undefined ? undefined : layerArtifact.state.kind).toBe("layer");
    const layerState =
      layerArtifact !== undefined && layerArtifact.state.kind === "layer"
        ? layerArtifact.state.layer
        : undefined;
    expect(layerState === undefined ? undefined : layerState.name).toBe("Points layer");

    // Blank names are refused, never trimmed away silently (the UI rule).
    await expect(
      t.mutation(api.layers.create, { kind: "group", name: "   ", projectId }),
    ).rejects.toThrow(/Give the layer a name/);
  });

  it("refuses a data layer whose dataset membership is missing, foreign, or not a dataset", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const otherProject = await createProject(t, "Other");
    const datasetId = await t.mutation(api.schemas.create, {
      schema: { properties: { label: { type: "string" } }, title: "Points", type: "object" },
    });
    const foreignMembership = await t.mutation(api.projects.addArtifact, {
      artifactId: datasetId,
      artifactKind: "dataset",
      projectId: otherProject,
    });

    await expect(
      t.mutation(api.layers.create, { kind: "data", name: "No data", projectId }),
    ).rejects.toThrow(/needs a dataset/);
    await expect(
      t.mutation(api.layers.create, {
        datasetMemberId: "not-an-id",
        kind: "data",
        name: "Junk",
        projectId,
      }),
    ).rejects.toThrow(/isn't a member of this project/);
    await expect(
      t.mutation(api.layers.create, {
        datasetMemberId: foreignMembership,
        kind: "data",
        name: "Foreign",
        projectId,
      }),
    ).rejects.toThrow(/isn't a member of this project/);
  });
});

describe("layers: link (published → pinned read-only member)", () => {
  it("pins the head version as the membership and refuses doubles and unpublished sources", async () => {
    const t = signedIn();
    const sourceProject = await createProject(t, "Source");
    const datasetId = await createGeospatialDataset(t);
    const sourceLayerId = await createDataLayer(t, sourceProject, datasetId, "River style");
    const versionId = await seedVersion(t, sourceLayerId, { kind: "data", name: "River style" });

    // Unpublished (no chain yet): refused with the honest answer — there is
    // nothing to pin.
    const target = await createProject(t, "Target");
    const bareLayer = await createDataLayer(t, target, datasetId, "Bare");
    await expect(
      t.mutation(api.layers.link, { layerId: bareLayer, projectId: target }),
    ).rejects.toThrow(/already owns that layer/);

    const pinnedVersionId = await t.mutation(api.layers.link, {
      layerId: sourceLayerId,
      projectId: target,
    });
    expect(pinnedVersionId).toBe(versionId);

    // The linked membership names the pinned version (the pin IS the
    // membership's artifactId) and resolves in the workspace read.
    const workspace = await t.query(api.projects.get, { projectId: target });
    const linked =
      workspace === null
        ? undefined
        : workspace.artifacts.find(
            (row) => row.artifactKind === "layer" && row.artifactId === pinnedVersionId,
          );
    expect(linked === undefined ? undefined : linked.role).toBe("linked");
    const linkedState =
      linked !== undefined && linked.state.kind === "layer" ? linked.state.layer : undefined;
    expect(linkedState === undefined ? undefined : linkedState.source).toBe("linked");
    expect(linkedState === undefined ? undefined : linkedState.pinnedVersionLabel).toBe("v1");

    // A double link — by source row or by pinned version — lands once.
    await expect(
      t.mutation(api.layers.link, { layerId: sourceLayerId, projectId: target }),
    ).rejects.toThrow(/already linked/);
    // And an unpublished source in a foreign project reads the publish gate.
    await expect(
      t.mutation(api.layers.link, { layerId: bareLayer, projectId: sourceProject }),
    ).rejects.toThrow(/Only a published layer can be linked/);
  });
});

describe("layers: clone (published → owned draft, deep for groups)", () => {
  it("clones a data layer into an editable owned draft and brings the dataset along as a linked member", async () => {
    const t = signedIn();
    const sourceProject = await createProject(t, "Source");
    const datasetId = await createGeospatialDataset(t);
    // Give the source a frozen dataset version to pin (the publish path's
    // shape, seeded directly): an already-published dataset row.
    const frozenDatasetId = await t.mutation(api.schemas.create, {
      schema: { properties: { label: { type: "string" } }, title: "Frozen points", type: "object" },
    });
    const sourceLayerId = await createDataLayer(t, sourceProject, datasetId, "River style");
    // The source membership the frozen version names (the clone's dataset
    // pin rides it).
    const sourceWorkspace = await t.query(api.projects.get, { projectId: sourceProject });
    const sourceMembership =
      sourceWorkspace === null
        ? undefined
        : sourceWorkspace.artifacts.find((row) => row.artifactKind === "dataset");
    if (sourceMembership === undefined) {
      throw new Error("expected the source dataset membership");
    }
    await seedVersion(
      t,
      sourceLayerId,
      {
        filter: undefined,
        kind: "data",
        name: "River style",
        style: { color: "#ef4444" },
      },
      {
        dataset: {
          pinnedRef: "ref::test",
          pinnedSchemaId: frozenDatasetId,
          sourceMemberId: sourceMembership._id,
        },
      },
    );

    const target = await createProject(t, "Target");
    const cloneId = await t.mutation(api.layers.clone, {
      layerId: sourceLayerId,
      projectId: target,
    });

    // The editable owned copy: draft lifecycle, the frozen definition's
    // fields, and a membership of its own.
    const clone = await layerOf(t, cloneId);
    expect(clone.lifecycle).toBe("draft");
    expect(clone.name).toBe("River style");
    expect(clone.datasetMemberId).not.toBeUndefined();
    const workspace = await t.query(api.projects.get, { projectId: target });
    const cloneArtifact =
      workspace === null
        ? undefined
        : workspace.artifacts.find((row) => row.artifactId === cloneId);
    expect(cloneArtifact === undefined ? undefined : cloneArtifact.role).toBe("owned");

    // The pinned dataset joined the target project as its own linked member.
    const datasetMember =
      workspace === null
        ? undefined
        : workspace.artifacts.find((row) => row.artifactId === frozenDatasetId);
    expect(datasetMember === undefined ? undefined : datasetMember.role).toBe("linked");

    // Editing the clone never touches the source.
    await t.mutation(api.layers.update, { layerId: cloneId, name: "My take" });
    expect((await layerOf(t, sourceLayerId)).name).toBe("River style");
  });

  it("clones a group deeply: owned children from their frozen versions, linked children re-pinned", async () => {
    const t = signedIn();
    const sourceProject = await createProject(t, "Source");
    const childDatasetId = await createGeospatialDataset(t);
    const childLayerId = await createDataLayer(t, sourceProject, childDatasetId, "Child");
    // The child's frozen version pins its dataset (a data version without a
    // frozen ref refuses to clone — cloneFromVersion's guard).
    const frozenDatasetId = await t.mutation(api.schemas.create, {
      schema: { properties: { label: { type: "string" } }, title: "Frozen", type: "object" },
    });
    const childWorkspace = await t.query(api.projects.get, { projectId: sourceProject });
    const childMembership =
      childWorkspace === null
        ? undefined
        : childWorkspace.artifacts.find((row) => row.artifactKind === "dataset");
    if (childMembership === undefined) {
      throw new Error("expected the child dataset membership");
    }
    const childVersionId = await seedVersion(
      t,
      childLayerId,
      { kind: "data", name: "Child" },
      {
        dataset: {
          pinnedRef: "ref::child",
          pinnedSchemaId: frozenDatasetId,
          sourceMemberId: childMembership._id,
        },
      },
    );
    const groupLayerId = await t.mutation(api.layers.create, {
      kind: "group",
      name: "River group",
      projectId: sourceProject,
    });
    await t.mutation(api.layers.addToGroup, { groupId: groupLayerId, layerId: childLayerId });
    const groupVersionId = await seedVersion(
      t,
      groupLayerId,
      { kind: "group", name: "River group", opacity: 0.8 },
      {
        frozenChildren: [{ childKind: "owned", childLayerId, versionId: childVersionId }],
      },
    );

    const target = await createProject(t, "Target");
    const cloneGroupId = await t.mutation(api.layers.clone, {
      layerId: groupLayerId,
      projectId: target,
    });
    const cloneGroup = await layerOf(t, cloneGroupId);
    expect(cloneGroup.kind).toBe("group");
    expect(cloneGroup.name).toBe("River group");
    expect(cloneGroup.children).toHaveLength(1);
    const clonedChild = cloneGroup.children[0];
    expect(clonedChild === undefined ? undefined : clonedChild.childKind).toBe("owned");
    const childId = clonedChild === undefined ? "" : clonedChild.childLayerId;
    // The cloned child is its OWN row in the target (deep, not shared).
    expect(childId).not.toBe(childLayerId);
    expect((await layerOf(t, childId)).name).toBe("Child");
    const targetWorkspace = await t.query(api.projects.get, { projectId: target });
    expect(
      targetWorkspace === null
        ? 0
        : targetWorkspace.artifacts.filter((row) => row.artifactKind === "layer").length,
    ).toBe(2);
    expect(groupVersionId).toBeTruthy();
  });
});

describe("layers: groups — group/ungroup/reparent/reorder with the cycle guard", () => {
  it("groups, refuses a second parent, and ungroups back to the root", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const datasetId = await createGeospatialDataset(t);
    const groupA = await t.mutation(api.layers.create, {
      kind: "group",
      name: "A",
      projectId,
    });
    const groupB = await t.mutation(api.layers.create, {
      kind: "group",
      name: "B",
      projectId,
    });
    const layer = await createDataLayer(t, projectId, datasetId, "Points");

    await t.mutation(api.layers.addToGroup, { groupId: groupA, layerId: layer });
    expect((await layerOf(t, layer)).parentGroupId).toBe(groupA);
    expect((await layerOf(t, groupA)).children).toHaveLength(1);

    // One parent at a time: addToGroup refuses; reparent moves.
    await expect(
      t.mutation(api.layers.addToGroup, { groupId: groupB, layerId: layer }),
    ).rejects.toThrow(/already grouped/);
    await t.mutation(api.layers.reparent, { groupId: groupB, layerId: layer });
    expect((await layerOf(t, layer)).parentGroupId).toBe(groupB);

    await t.mutation(api.layers.removeFromGroup, { groupId: groupB, layerId: layer });
    expect((await layerOf(t, layer)).parentGroupId).toBeUndefined();
    await expect(
      t.mutation(api.layers.removeFromGroup, { groupId: groupB, layerId: layer }),
    ).rejects.toThrow(/isn't in this group/);
  });

  it("guards the tree acyclic: a group can't move inside its own subtree", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const outer = await t.mutation(api.layers.create, { kind: "group", name: "Outer", projectId });
    const inner = await t.mutation(api.layers.create, { kind: "group", name: "Inner", projectId });
    await t.mutation(api.layers.addToGroup, { groupId: outer, layerId: inner });

    // Self, direct ancestor, and deep-ancestor cycles all refuse.
    await expect(
      t.mutation(api.layers.reparent, { groupId: inner, layerId: inner }),
    ).rejects.toThrow(/can't be grouped inside itself/);
    await expect(
      t.mutation(api.layers.reparent, { groupId: inner, layerId: outer }),
    ).rejects.toThrow(/subtree/);
    await expect(
      t.mutation(api.layers.addToGroup, { groupId: outer, layerId: outer }),
    ).rejects.toThrow(/can't be grouped inside itself/);
  });

  it("reorders children by neighbor swap and reparents to the root", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const datasetId = await createGeospatialDataset(t);
    const group = await t.mutation(api.layers.create, { kind: "group", name: "G", projectId });
    const first = await createDataLayer(t, projectId, datasetId, "First");
    const second = await createDataLayer(t, projectId, datasetId, "Second");
    await t.mutation(api.layers.addToGroup, { groupId: group, layerId: first });
    await t.mutation(api.layers.addToGroup, { groupId: group, layerId: second });

    await t.mutation(api.layers.reorder, { direction: "up", groupId: group, layerId: second });
    let children = (await layerOf(t, group)).children;
    expect(children.map((row) => row.childLayerId)).toStrictEqual([second, first]);

    // A no-op at the end stays a no-op.
    await t.mutation(api.layers.reorder, { direction: "up", groupId: group, layerId: second });
    children = (await layerOf(t, group)).children;
    expect(children.map((row) => row.childLayerId)).toStrictEqual([second, first]);

    // Reparent to the root (no groupId) leaves the group empty.
    await t.mutation(api.layers.reparent, { layerId: second });
    expect((await layerOf(t, second)).parentGroupId).toBeUndefined();
    expect((await layerOf(t, group)).children).toHaveLength(1);
  });

  it("removing a group unparents its children — never deletes them", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const datasetId = await createGeospatialDataset(t);
    const group = await t.mutation(api.layers.create, { kind: "group", name: "G", projectId });
    const child = await createDataLayer(t, projectId, datasetId, "Child");
    await t.mutation(api.layers.addToGroup, { groupId: group, layerId: child });

    await t.mutation(api.layers.remove, { layerId: group });
    expect((await layerOf(t, child)).parentGroupId).toBeUndefined();
    const listed = await t.query(api.layers.list, { projectId });
    expect(listed.map((row) => row._id)).toContain(child);
  });
});

describe("layers: schema drift → needsAttention (ADR 0012)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Publishes a draft's current rows as its next version; resolves to the frozen row's id (the projects.test.ts helper, reshaped). */
  async function publishDraft(
    t: TestConvex,
    draftId: string,
    rows: Array<{ data: Record<string, unknown> }>,
  ): Promise<string> {
    const started = await t.mutation(api.publish.start, { datasetKey: draftId });
    await t.mutation(api.publish.plan, {
      attemptId: started.attemptId,
      chunkCount: rows.length === 0 ? 0 : 1,
      totalRows: rows.length,
    });
    if (rows.length > 0) {
      const bytes = new TextEncoder().encode(JSON.stringify(rows)),
        storageId = await t.action(components.jsonCms.host_support.storeTestBlob, {
          bytes: bytes.buffer,
        });
      const { uploadId } = await t.run(async (ctx) =>
        ctx.runMutation(components.jsonCms.lib.generateUploadUrl, { scope: started.attemptId }),
      );
      await t.mutation(api.publish.registerChunk, {
        attemptId: started.attemptId,
        rowCount: rows.length,
        storageId,
        uploadId,
      });
    }
    const frozen = await t.mutation(api.publish.freeze, { attemptId: started.attemptId });
    await t.finishAllScheduledFunctions(() => {
      vi.runAllTimers();
    });
    return frozen.schemaId;
  }

  it("flags the layer when a sync moves its dataset onto fields it doesn't style, and the next styling write clears it", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    // A standalone draft (fields: label), published once — the linked member's pin sits here.
    const draftId = await t.run(async (ctx) =>
      ctx.runMutation(components.jsonCms.lib.createSchema, {
        actorId: "user-1",
        lifecycle: "draft",
        schema: {
          properties: { label: { type: "string" } },
          title: "Source",
          type: "object",
        },
      }),
    );
    await t.mutation(api.entries.create, { data: { label: "A" }, schemaId: draftId });
    const v1 = await publishDraft(t, draftId, [{ data: { label: "A" } }]);
    // The FROZEN row joins the project (a linked member with a pin) — a
    // draft would land owned and carry no sync surface at all.
    const membershipId = await t.mutation(api.projects.addArtifact, {
      artifactId: v1,
      artifactKind: "dataset",
      projectId,
    });
    const layerId = await t.mutation(api.layers.create, {
      datasetMemberId: membershipId,
      kind: "data",
      name: "Styled",
      projectId,
    });

    // The source gains a field; v2 freezes with BOTH fields.
    await t.mutation(api.schemas.update, {
      schema: {
        properties: { category: { type: "string" }, label: { type: "string" } },
        title: "Source",
        type: "object",
      },
      schemaId: draftId,
    });
    await publishDraft(t, draftId, [{ data: { category: "x", label: "A" } }]);

    // The layer was styled between the pins (a styling write), so the flag
    // starts clear.
    await t.mutation(api.layers.update, { layerId, name: "Styled" });

    // The workspace's Sync action moves the pin — the drift stamp rides the
    // SAME transaction (no broken layer, a flag instead).
    const workspace = await t.query(api.projects.get, { projectId });
    const datasetArtifact =
      workspace === null
        ? undefined
        : workspace.artifacts.find((row) => row.artifactKind === "dataset");
    const sync = datasetArtifact === undefined ? undefined : datasetArtifact.sync;
    expect(sync).not.toBeUndefined();
    if (sync === undefined) {
      throw new Error("expected sync state");
    }
    await t.mutation(api.consumption.syncReference, { referenceId: sync.referenceId });

    const drifted = await layerOf(t, layerId);
    expect(drifted.needsAttention).toContain("fields changed");

    // The next styling write reconciles: the flag clears.
    await t.mutation(api.layers.update, { layerId, name: "Styled v2" });
    expect((await layerOf(t, layerId)).needsAttention).toBeUndefined();
  });
});
