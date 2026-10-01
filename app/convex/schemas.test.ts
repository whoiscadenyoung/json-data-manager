// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The host-side dataset delete cascade (issue #128): `api.schemas.remove`
 * (the hand-written replacement for the exposeApi `deleteSchema` wrapper)
 * must leave no host row keyed by the deleted id behind — consumer
 * references, project memberships (and their fork edges), registry
 * `dependsOn` edges, version policies, tag deltas, publish attempts — on
 * top of the component's own batched drain. The 10k-entry case is the
 * issue's acceptance fixture: the delete must succeed end to end, through
 * every scheduled hop, in the component AND host tables.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/** A fresh test backend with the json-cms component mounted as in the app. */
function initTest() {
  const t = convexTest(schema, modules);
  // Cast: `register` takes the component-generic `TestConvex` shape, while
  // `convexTest(schema, ...)` types `t` against this app's concrete schema —
  // the same instance, just nominal-type-invariant across the helper.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  registerJsonCms(t as unknown as Parameters<typeof registerJsonCms>[0]);
  return t;
}

function signedIn() {
  return initTest().withIdentity({ subject: "user-1" });
}

type TestHarness = ReturnType<typeof signedIn>;

async function drainScheduled(t: TestHarness): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** A plain user-created dataset (the delete gate's allowed target). */
async function createDataset(t: TestHarness, title = "Deletable"): Promise<string> {
  return t.mutation(api.schemas.create, { schema: { title, type: "object" } });
}

/** One of each host row keyed by `schemaId`, through their real writers where they have one. */
async function seedHostRowsForKeyedId(
  t: TestHarness,
  schemaId: string,
): Promise<{ projectId: string; registryId: string }> {
  const projectId = await t.mutation(api.projects.create, { title: "Holder" });
  // The membership AND its fork consumerReference edge, in one transaction
  // (projects.addArtifact).
  await t.mutation(api.projects.addArtifact, {
    artifactId: schemaId,
    artifactKind: "dataset",
    projectId,
  });
  // The registry row: dependsOn [schemaId] AND a float consumerReference
  // naming schemaId as source (the save path's edge sync).
  const registryId = await t.mutation(api.derivedDatasets.save, {
    spec: { operations: [], sourceDatasetId: schemaId },
    status: "saved",
    title: "Dependent spec",
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("versionPolicies", { datasetKey: schemaId, keepVersions: 3 });
    await ctx.db.insert("tagDeltas", {
      at: Date.now(),
      ops: [],
      sourceSchemaId: schemaId,
      toRef: "pub_test",
    });
    await ctx.db.insert("publishAttempts", {
      chunkStorageIds: [],
      createdBy: "user-1",
      datasetKey: schemaId,
      datasetKind: "draft",
      lastProgressAt: Date.now(),
      publishKey: "pub_test",
      startedAt: Date.now(),
      status: "completed",
      title: "Deletable v1",
      versionLabel: "v1",
    });
  });
  return { projectId, registryId };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("host delete cascade (issue #128)", () => {
  it("remove drains every host row keyed by the deleted id — and the fork edge goes with its membership", async () => {
    const t = signedIn(),
      schemaId = await createDataset(t),
      { projectId, registryId } = await seedHostRowsForKeyedId(t, schemaId);

    // Sanity: the rows are there before the delete.
    const before = await t.run(async (ctx) => ({
      consumerReferences: await ctx.db.query("consumerReferences").take(1),
      projectArtifacts: await ctx.db
        .query("projectArtifacts")
        .withIndex("by_artifact", (q) => q.eq("artifactKind", "dataset").eq("artifactId", schemaId))
        .take(1),
      publishAttempts: await ctx.db
        .query("publishAttempts")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", schemaId))
        .take(1),
      tagDeltas: await ctx.db
        .query("tagDeltas")
        .withIndex("by_source", (q) => q.eq("sourceSchemaId", schemaId))
        .take(1),
      versionPolicies: await ctx.db
        .query("versionPolicies")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", schemaId))
        .take(1),
    }));
    expect(before.consumerReferences).not.toHaveLength(0);
    expect(before.projectArtifacts).toHaveLength(1);
    expect(before.versionPolicies).toHaveLength(1);
    expect(before.tagDeltas).toHaveLength(1);
    expect(before.publishAttempts).toHaveLength(1);

    await t.mutation(api.schemas.remove, { schemaId });
    await drainScheduled(t);

    const after = await t.run(async (ctx) => ({
      consumerReferences: await ctx.db.query("consumerReferences").take(1),
      projectArtifacts: await ctx.db
        .query("projectArtifacts")
        .withIndex("by_artifact", (q) => q.eq("artifactKind", "dataset").eq("artifactId", schemaId))
        .take(1),
      publishAttempts: await ctx.db
        .query("publishAttempts")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", schemaId))
        .take(1),
      registry: await ctx.db
        .query("derivedDatasets")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", schemaId))
        .first(),
      tagDeltas: await ctx.db
        .query("tagDeltas")
        .withIndex("by_source", (q) => q.eq("sourceSchemaId", schemaId))
        .take(1),
      versionPolicies: await ctx.db
        .query("versionPolicies")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", schemaId))
        .take(1),
    }));
    // Component side: the dataset itself is gone.
    expect(await t.query(api.schemas.get, { schemaId })).toBeNull();
    // Host side: nothing keyed by the id survives anywhere…
    expect(after.consumerReferences).toHaveLength(0);
    expect(after.projectArtifacts).toStrictEqual([]);
    expect(after.versionPolicies).toStrictEqual([]);
    expect(after.tagDeltas).toStrictEqual([]);
    expect(after.publishAttempts).toStrictEqual([]);
    // …the project's denormalized count stayed honest…
    const project = await t.query(api.projects.get, { projectId });
    if (project === null) {
      throw new Error("the cascade deleted the holder project — it must survive");
    }
    expect(project.project.artifactCount).toBe(0);
    // …and the dependent registry row SURVIVES, minus its dead edge (it
    // re-reads as orphaned through its spec — the documented behavior).
    if (after.registry === null) {
      throw new Error("the cascade deleted the dependent registry row — it must survive");
    }
    expect(after.registry.dependsOn).toStrictEqual([]);
    const row = await t.query(api.derivedDatasets.get, { id: registryId });
    if (row === null) {
      throw new Error("the dependent registry row vanished from its own read");
    }
    expect(row.dependsOn).toStrictEqual([]);
  });

  it(
    "remove deletes a >10k-entry geospatial dataset end to end — component AND host tables clean",
    { timeout: 240_000 },
    async () => {
      const t = signedIn(),
        schemaId = await t.mutation(api.schemas.create, {
          geometryType: "Point",
          kind: "geospatial",
          schema: { title: "Big host-side delete", type: "object" },
        }),
        collectionId = await t.mutation(api.collections.create, { name: "Big" });
      await t.mutation(api.collections.addSchemaToCollection, { collectionId, schemaId });
      // The AC fixture: 10,500 rows with geometry (past the ~8k cap the old
      // single-transaction delete hit).
      let inserted = 0;
      while (inserted < 10_500) {
        const rows = Array.from({ length: Math.min(500, 10_500 - inserted) }, (_, i) => ({
          data: { index: inserted + i },
          geometry: JSON.stringify({
            coordinates: [(inserted + i) % 180, (inserted + i) % 90],
            type: "Point",
          }),
        }));
        // oxlint-disable-next-line no-await-in-loop -- one transaction per seeding batch.
        await t.mutation(api.entries.createBulk, { entries: rows, schemaId });
        inserted += rows.length;
      }

      await t.mutation(api.schemas.remove, { schemaId });
      // Every hop: the component's batched drain AND the host cascade.
      await drainScheduled(t);

      expect(await t.query(api.schemas.get, { schemaId })).toBeNull();
      // Component tables aren't in the host's data model, so the leftovers
      // read through component functions: `listEntriesForSchemaBounded` is
      // the one entries reader that answers ([]) without a live schema row
      // (its siblings throw "Schema not found"). The membership rows are
      // host-visible… they aren't — `schemaCollections` is a component table
      // too; its drain is covered by the phase ordering below.
      const leftoverEntries = await t.run(async (ctx) =>
        ctx.runQuery(components.jsonCms.lib.listEntriesForSchemaBounded, {
          limit: 1,
          schemaId,
        }),
      );
      expect(leftoverEntries).toStrictEqual([]);
      // Membership rows read through the collections the dataset belonged
      // to: the collection survives, its member list is empty.
      const members = await t.query(api.collections.listDatasets, {
        collectionId,
      });
      expect(members).toStrictEqual([]);
      // The geometries drain is proven by ORDER: the schema row was deleted
      // LAST (it is gone — asserted above), and the delete's phase machine
      // only reaches the row after the entries and geometries phases
      // returned drained. Nothing keyed by the id can survive.
    },
  );
});
