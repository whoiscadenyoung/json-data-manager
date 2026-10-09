// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * Project-owned maps (phase 3 of the project-workspace design, ADR 0012) —
 * driven through `api.projectMaps.*` on a real (test) backend, the
 * projects.test.ts conventions: the role access matrix, CRUD, the placement
 * model (placements name layer members, layers answer live or pinned), and
 * the AUTO-LAYER flow — one dataset click lands membership + layer +
 * placement; a collection/group target auto-layers every geospatial dataset
 * ("add all datasets from collection") and reports the skipped rest.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
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
type Placement = FunctionReturnType<typeof api.projectMaps.layers>[number];

async function createProject(t: TestConvex, title = "Map home"): Promise<Id<"projects">> {
  return t.mutation(api.projects.create, { title });
}

/** A geospatial PUBLISHED dataset (absent lifecycle reads as published). */
async function createGeospatialDataset(t: TestConvex, title = "Points"): Promise<string> {
  return t.mutation(api.schemas.create, {
    geometryType: "Point",
    kind: "geospatial",
    schema: { properties: { label: { type: "string" } }, title, type: "object" },
  });
}

/** A standard (non-geospatial) PUBLISHED dataset. */
async function createStandardDataset(t: TestConvex, title = "Table"): Promise<string> {
  return t.mutation(api.schemas.create, {
    schema: { properties: { label: { type: "string" } }, title, type: "object" },
  });
}

/** The placements read, narrowed to the owned arm (tests always seed owned layers). */
function ownedPlacement(placement: Placement): {
  name: string;
  needsAttention?: string;
} {
  if (placement.kind !== "owned") {
    throw new Error(`expected an owned placement, got ${placement.kind}`);
  }
  return placement.layer;
}

describe("projectMaps: the gate and the role access matrix (ADR 0012)", () => {
  it("rejects anonymous callers on every function", async () => {
    const anonymous = initTest();
    await expect(anonymous.query(api.projectMaps.list, { projectId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(anonymous.query(api.projectMaps.layers, { mapId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      anonymous.mutation(api.projectMaps.create, { name: "Nope", projectId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projectMaps.update, { mapId: "x", name: "Nope" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(anonymous.mutation(api.projectMaps.remove, { mapId: "x" })).rejects.toThrow(
      GATE_MESSAGE,
    );
    await expect(
      anonymous.mutation(api.projectMaps.move, { direction: "up", mapId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projectMaps.addLayer, { layerMemberId: "x", mapId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projectMaps.removeLayer, { mapLayerId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projectMaps.setLayerVisibility, { mapLayerId: "x", visible: false }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projectMaps.moveLayer, { direction: "up", mapLayerId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projectMaps.addDatasetToMap, { datasetId: "x", mapId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      anonymous.mutation(api.projectMaps.addAllDatasets, { collectionId: "x", mapId: "x" }),
    ).rejects.toThrow(GATE_MESSAGE);
  });

  it("seats writes at editor-and-up; viewer and outsider get the gone answer; reads answer to any member only", async () => {
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
    await owner.mutation(api.projects.addMember, { projectId, role: "editor", user: "editor-1" });
    await owner.mutation(api.projects.addMember, { projectId, role: "viewer", user: "viewer-1" });
    const editor = owner.withIdentity({ subject: "editor-1" }),
      viewer = owner.withIdentity({ subject: "viewer-1" }),
      outsider = owner.withIdentity({ subject: "outsider-1" });

    const mapId = await editor.mutation(api.projectMaps.create, {
      name: "Editor's map",
      projectId,
    });
    expect(mapId).toBeTruthy();

    // Reads answer to every member — and to nobody else.
    expect(await viewer.query(api.projectMaps.layers, { mapId })).toEqual([]);
    expect(
      (await viewer.query(api.projectMaps.list, { projectId })).map((row) => row._id),
    ).toContain(mapId);
    expect(await outsider.query(api.projectMaps.list, { projectId })).toEqual([]);
    expect(await outsider.query(api.projectMaps.layers, { mapId })).toEqual([]);

    // Writes answer to editor-and-up; viewer and outsider read the gone
    // answer (an id's existence never leaks through a denied write).
    for (const caller of [viewer, outsider]) {
      await expect(
        caller.mutation(api.projectMaps.create, { name: "Nope", projectId }),
      ).rejects.toThrow(GONE);
      await expect(
        caller.mutation(api.projectMaps.update, { mapId, name: "Nope" }),
      ).rejects.toThrow(GONE);
      await expect(caller.mutation(api.projectMaps.remove, { mapId })).rejects.toThrow(GONE);
      await expect(
        caller.mutation(api.projectMaps.addDatasetToMap, { datasetId: "x", mapId }),
      ).rejects.toThrow(GONE);
      await expect(caller.mutation(api.projectMaps.addAllDatasets, { mapId })).rejects.toThrow(
        GONE,
      );
    }
  });
});

describe("projectMaps: CRUD", () => {
  it("creates (append order), renames, saves the viewport/basemap, reorders, and removes", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const first = await t.mutation(api.projectMaps.create, { name: "First", projectId });
    const second = await t.mutation(api.projectMaps.create, { name: "Second", projectId });

    let listed = await t.query(api.projectMaps.list, { projectId });
    expect(listed.map((row) => row.name)).toStrictEqual(["First", "Second"]);

    await t.mutation(api.projectMaps.update, {
      basemap: "dark",
      mapId: first,
      name: "Renamed",
      viewport: { bounds: [0, 0, 1, 1], zoom: 9 },
    });
    await t.mutation(api.projectMaps.move, { direction: "up", mapId: second });
    listed = await t.query(api.projectMaps.list, { projectId });
    expect(listed.map((row) => row._id)).toStrictEqual([second, first]);
    const renamed = listed.find((row) => row._id === first);
    expect(renamed === undefined ? undefined : renamed.basemap).toBe("dark");

    // A blank name is refused, never trimmed away silently (the UI rule).
    await expect(t.mutation(api.projectMaps.update, { mapId: first, name: "  " })).rejects.toThrow(
      /Give the map a name/,
    );

    // Removal takes the placements with it — and nothing else.
    const datasetId = await createGeospatialDataset(t);
    await t.mutation(api.layers.create, { kind: "group", name: "L", projectId });
    const workspace = await t.query(api.projects.get, { projectId });
    const layerMembership =
      workspace === null
        ? undefined
        : workspace.artifacts.find((row) => row.artifactKind === "layer");
    if (layerMembership === undefined) {
      throw new Error("expected the layer membership");
    }
    expect(datasetId).toBeTruthy();
    const placement = await t.mutation(api.projectMaps.addLayer, {
      layerMemberId: layerMembership._id,
      mapId: first,
    });
    await t.mutation(api.projectMaps.remove, { mapId: first });
    listed = await t.query(api.projectMaps.list, { projectId });
    expect(listed.map((row) => row._id)).toStrictEqual([second]);
    const leftovers = await t.run(async (ctx) => ctx.db.get(placement));
    expect(leftovers).toBeNull();
  });
});

describe("projectMaps: placements", () => {
  it("places layer members once, resolves owned and linked members differently, and supports remove/visibility/reorder", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const datasetId = await createGeospatialDataset(t);
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
    });
    // The layer's OWN membership (its placements name it through it).
    const workspace = await t.query(api.projects.get, { projectId });
    const layerArtifact =
      workspace === null
        ? undefined
        : workspace.artifacts.find((row) => row.artifactKind === "layer");
    if (layerArtifact === undefined) {
      throw new Error("expected the layer membership");
    }
    const mapId = await t.mutation(api.projectMaps.create, { name: "Canvas", projectId });

    const placement = await t.mutation(api.projectMaps.addLayer, {
      layerMemberId: layerArtifact._id,
      mapId,
    });
    // The once-per-layer guard (the component addMapLayer's shape).
    await expect(
      t.mutation(api.projectMaps.addLayer, { layerMemberId: layerArtifact._id, mapId }),
    ).rejects.toThrow(/already on this map/);
    // A layer membership of ANOTHER project is refused.
    const otherProject = await createProject(t, "Other");
    const otherMembership = await t.mutation(api.projects.addArtifact, {
      artifactId: datasetId,
      artifactKind: "dataset",
      projectId: otherProject,
    });
    await expect(
      t.mutation(api.projectMaps.addLayer, { layerMemberId: otherMembership, mapId }),
    ).rejects.toThrow(/isn't a member of this map's project/);

    // The owned placement resolves through the live layer row.
    let placements = await t.query(api.projectMaps.layers, { mapId });
    expect(placements).toHaveLength(1);
    const owned = ownedPlacement(placements[0] as Placement);
    expect(owned.name).toBe("Points layer");

    // Map-local visibility and draw order.
    await t.mutation(api.projectMaps.setLayerVisibility, { mapLayerId: placement, visible: false });
    placements = await t.query(api.projectMaps.layers, { mapId });
    expect(placements[0] === undefined ? undefined : placements[0].visible).toBe(false);

    // Removing the placement unhooks the layer from the canvas — the layer
    // itself survives.
    await t.mutation(api.projectMaps.removeLayer, { mapLayerId: placement });
    expect(await t.query(api.projectMaps.layers, { mapId })).toEqual([]);
    expect(await t.query(api.layers.get, { layerId })).not.toBeNull();
  });
});

describe("projectMaps: auto-layer (add dataset to map, ADR 0012)", () => {
  it("lands membership + owned layer + placement in one click; idempotent; refuses non-geospatial", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const mapId = await t.mutation(api.projectMaps.create, { name: "Canvas", projectId });
    const geospatialId = await createGeospatialDataset(t, "IG points");
    const standardId = await createStandardDataset(t, "A table");

    // Only a geospatial dataset layers meaningfully — a standard one is
    // refused with the reason, never layered into nothing.
    await expect(
      t.mutation(api.projectMaps.addDatasetToMap, { datasetId: standardId, mapId }),
    ).rejects.toThrow(/geospatial/);

    const first = await t.mutation(api.projectMaps.addDatasetToMap, {
      datasetId: geospatialId,
      mapId,
    });
    expect(first.created).toBe(true);

    // The workspace grew one dataset member AND one layer member.
    const workspace = await t.query(api.projects.get, { projectId });
    const byKind = new Map<string, number>();
    if (workspace !== null) {
      for (const artifact of workspace.artifacts) {
        byKind.set(artifact.artifactKind, (byKind.get(artifact.artifactKind) ?? 0) + 1);
      }
    }
    expect(byKind.get("dataset")).toBe(1);
    expect(byKind.get("layer")).toBe(1);

    // The placement resolves through the live layer, named for the dataset.
    const placements = await t.query(api.projectMaps.layers, { mapId });
    expect(placements).toHaveLength(1);
    expect(ownedPlacement(placements[0] as Placement).name).toBe("IG points");

    // Idempotent: the second click reuses the layer AND the placement.
    const again = await t.mutation(api.projectMaps.addDatasetToMap, {
      datasetId: geospatialId,
      mapId,
    });
    expect(again.created).toBe(false);
    expect(again.layerId).toBe(first.layerId);
    expect(again.mapLayerId).toBe(first.mapLayerId);
    expect(await t.query(api.projectMaps.layers, { mapId })).toHaveLength(1);
  });

  it("add all datasets from a collection — one layer per geospatial dataset, skips reported", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const mapId = await t.mutation(api.projectMaps.create, { name: "Canvas", projectId });
    const geoA = await createGeospatialDataset(t, "Points A");
    const geoB = await createGeospatialDataset(t, "Polygons B");
    const table = await createStandardDataset(t, "A table");
    const collectionId = await t.mutation(api.collections.create, { name: "Corridor" });
    for (const datasetId of [geoA, geoB, table]) {
      await t.mutation(api.collections.addSchemaToCollection, {
        collectionId,
        schemaId: datasetId,
      });
    }

    const outcome = await t.mutation(api.projectMaps.addAllDatasets, {
      collectionId,
      mapId,
    });
    expect(outcome.added).toBe(2);
    expect(outcome.skipped).toBe(1);

    const placements = await t.query(api.projectMaps.layers, { mapId });
    expect(placements).toHaveLength(2);
    // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; .toSorted() isn't in the lib app/convex typechecks against.
    const names = placements.map((placement) => ownedPlacement(placement).name).sort();
    expect(names).toStrictEqual(["Points A", "Polygons B"]);

    // Idempotent: re-adding reuses everything.
    const again = await t.mutation(api.projectMaps.addAllDatasets, { collectionId, mapId });
    expect(again.added).toBe(2);
    expect(await t.query(api.projectMaps.layers, { mapId })).toHaveLength(2);

    // Exactly one target: both (or neither) is refused.
    await expect(
      t.mutation(api.projectMaps.addAllDatasets, { collectionId, groupId: "g", mapId }),
    ).rejects.toThrow(/exactly one/);
    await expect(t.mutation(api.projectMaps.addAllDatasets, { mapId })).rejects.toThrow(
      /exactly one/,
    );
  });

  it("add all datasets from a group expands the group's members", async () => {
    const t = signedIn();
    const projectId = await createProject(t);
    const mapId = await t.mutation(api.projectMaps.create, { name: "Canvas", projectId });
    const geoA = await createGeospatialDataset(t, "Grouped A");
    const geoB = await createGeospatialDataset(t, "Grouped B");
    const groupId = await t.mutation(api.groups.create, { name: "IG group" });
    for (const datasetId of [geoA, geoB]) {
      await t.mutation(api.collections.setSchemaGroup, { groupId, schemaId: datasetId });
    }

    const outcome = await t.mutation(api.projectMaps.addAllDatasets, { groupId, mapId });
    expect(outcome.added).toBe(2);
    expect(outcome.skipped).toBe(0);
    expect(await t.query(api.projectMaps.layers, { mapId })).toHaveLength(2);
  });
});
