// @vitest-environment edge-runtime
/// <reference types="vite/client" />

/**
 * The derived-dataset registry's function-level behavior (roadmap stage 2,
 * #95): the save-time cycle gate over the real mutation (§3 lines 87-90 —
 * the acceptance criterion's A→B→C→A), derived-of-derived saves, the
 * sign-in gate, and read-time health (orphaned/stale). Pure walk/staleness
 * logic is unit-tested in derivedSpec.test.ts with stand-ins; everything
 * here runs through `api.derivedDatasets.*` on a real (test) backend, the
 * auth.test.ts setup.
 */
import { register as registerJsonCms } from "@caden/json-cms/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const GATE_MESSAGE = /signed out/i,
  CYCLE_MESSAGE = /circular dependency/i;

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

/** Runs every scheduled function — the host delete cascade's hops — to completion (the schemas.test.ts helper). */
async function drainScheduled(t: ReturnType<typeof signedIn>): Promise<void> {
  await t.finishAllScheduledFunctions(() => {
    vi.runAllTimers();
  });
}

/** A component dataset with the declared columns, as the builder would target it. */
async function createComponentDataset(
  t: ReturnType<typeof signedIn>,
  properties: Record<string, unknown>,
) {
  return t.mutation(api.schemas.create, {
    kind: "standard",
    schema: { properties, title: "Grants", type: "object" },
  });
}

interface SaveArgs {
  description?: string;
  id?: string;
  spec: unknown;
  status: "draft" | "saved";
  title: string;
}

function saveArgs(spec: unknown, overrides: Partial<SaveArgs> = {}): SaveArgs {
  return { spec, status: "saved", title: "Grants enriched", ...overrides };
}

function specOf(source: string) {
  return { operations: [], sourceDatasetId: source };
}

function lookupSpec(
  source: string,
  lookupDataset: string,
  baseKey = "GrantId",
  lookupKey = "GrantId",
) {
  return {
    operations: [
      { baseKey, kind: "lookup", lookupDatasetId: lookupDataset, lookupKey, namespace: "Grants" },
    ],
    sourceDatasetId: source,
  };
}

describe("gate", () => {
  it("rejects every registry function signed out", async () => {
    const t = initTest();
    await expect(
      t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec("s", "s"))),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(
      t.query(api.derivedDatasets.listBySource, { sourceDatasetId: "s" }),
    ).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.derivedDatasets.summaries, {})).rejects.toThrow(GATE_MESSAGE);
    await expect(t.query(api.derivedDatasets.get, { id: "x" })).rejects.toThrow(GATE_MESSAGE);
    await expect(t.mutation(api.derivedDatasets.remove, { id: "x" })).rejects.toThrow(GATE_MESSAGE);
  });
});

describe("save + read back", () => {
  it("saves a spec over a component dataset and lists it with health and persisted edges", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      id = await t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(schemaId, schemaId)));

    const rows = await t.query(api.derivedDatasets.listBySource, { sourceDatasetId: schemaId });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("row missing");
    }
    expect(row._id).toBe(id);
    expect(row.createdBy).toBe("user-1");
    expect(row.sourceDatasetId).toBe(schemaId);
    expect(row.status).toBe("saved");
    expect(row.health).toBe("ready");
    expect(row.healthReason).toBeUndefined();

    const doc = await t.query(api.derivedDatasets.get, { id });
    expect(doc === null).toBe(false);
    expect(doc === null ? undefined : doc.dependsOn).toStrictEqual([schemaId]);
    expect(doc === null ? undefined : doc.spec).toStrictEqual(lookupSpec(schemaId, schemaId));

    const summaries = await t.query(api.derivedDatasets.summaries, {});
    expect(summaries.map((summary) => summary._id)).toStrictEqual([id]);
  });

  it("autosaves as a draft and later saves the same row explicitly (one doc, not a fork)", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      draftId = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId), { status: "draft", title: "Untitled transform" }),
      );

    const draftRows = await t.query(api.derivedDatasets.listBySource, {
      sourceDatasetId: schemaId,
    });
    expect(draftRows[0] === undefined ? undefined : draftRows[0].status).toBe("draft");
    // Drafts are invisible to the catalog projection (lifecycle doc §3) —
    // an autosave must never surface in the browser as a derived dataset.
    expect(await t.query(api.derivedDatasets.summaries, {})).toStrictEqual([]);

    const savedId = await t.mutation(
      api.derivedDatasets.save,
      saveArgs(lookupSpec(schemaId, schemaId), {
        id: draftId,
        status: "saved",
        title: "Grants enriched",
      }),
    );
    expect(savedId).toBe(draftId);

    const rows = await t.query(api.derivedDatasets.listBySource, { sourceDatasetId: schemaId });
    expect(rows).toHaveLength(1);
    expect(rows[0] === undefined ? undefined : rows[0].status).toBe("saved");
  });

  it("keeps sourceDatasetId in lockstep when a spec is retargeted to another source", async () => {
    const t = signedIn(),
      first = await createComponentDataset(t, { GrantId: { type: "string" } }),
      second = await createComponentDataset(t, { GrantId: { type: "string" } }),
      id = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(first, first), { title: "A" }),
      );

    await t.mutation(
      api.derivedDatasets.save,
      saveArgs(lookupSpec(second, second), { id, title: "A" }),
    );

    // The row files under the NEW source only, and its edges lead with it.
    expect(
      await t.query(api.derivedDatasets.listBySource, { sourceDatasetId: first }),
    ).toStrictEqual([]);
    const rows = await t.query(api.derivedDatasets.listBySource, { sourceDatasetId: second });
    expect(rows.map((row) => row._id)).toStrictEqual([id]);
    const doc = await t.query(api.derivedDatasets.get, { id });
    expect(doc === null ? undefined : doc.sourceDatasetId).toBe(second);
    expect(doc === null ? undefined : doc.dependsOn).toStrictEqual([second]);
  });

  it("rejects a titleless save and an id that is not a registry row", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } });

    await expect(
      t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId), { title: "   " }),
      ),
    ).rejects.toThrow(/title/i);
    await expect(
      t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId), { id: "not-a-registry-id" }),
      ),
    ).rejects.toThrow(/no longer exists/i);
  });

  it("rejects a spec the engine cannot run", async () => {
    const t = signedIn();
    await expect(
      t.mutation(
        api.derivedDatasets.save,
        saveArgs({
          operations: [{ kind: "lookup", lookupDatasetId: "l" }],
          sourceDatasetId: "s",
        }),
      ),
    ).rejects.toThrow(/baseKey/);
  });
});

describe("cycle rejection at save time (the acceptance criterion)", () => {
  it("rejects A→B→C→A with a clear error, and accepts the chain before the closing edge", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      a = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId), { title: "A" }),
      ),
      // B reads A (derived-of-derived source) — fine.
      b = await t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(a, a), { title: "B" })),
      // C reads B — the chain A←B←C is a healthy DAG so far.
      c = await t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(b, b), { title: "C" }));

    // Closing the loop by pointing A at C is rejected before any write.
    await expect(
      t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(c, c), { id: a, title: "A" })),
    ).rejects.toThrow(CYCLE_MESSAGE);
    // The rejected save changed nothing.
    const after = await t.query(api.derivedDatasets.get, { id: a });
    if (after === null) {
      throw new Error("A vanished");
    }
    expect(after.dependsOn).toStrictEqual([schemaId]);

    // …and a direct self-reference is the same rejection.
    await expect(
      t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(a, a), { id: a, title: "A" })),
    ).rejects.toThrow(CYCLE_MESSAGE);
    expect(c).toBeTruthy();
  });

  it("rejects retargeting a source onto its own dependent", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      a = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId), { title: "A" }),
      ),
      // B's SOURCE is A.
      b = await t.mutation(api.derivedDatasets.save, saveArgs(specOf(a), { title: "B" }));

    // Retargeting A's source to B would close A → B → A.
    await expect(
      t.mutation(api.derivedDatasets.save, saveArgs(specOf(b), { id: a, title: "A" })),
    ).rejects.toThrow(CYCLE_MESSAGE);
  });
});

describe("read-time health", () => {
  it("reports orphaned when a source dataset does not exist", async () => {
    const t = signedIn(),
      id = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec("vanished-dataset", "vanished-dataset")),
      );

    const row = (
      await t.query(api.derivedDatasets.listBySource, { sourceDatasetId: "vanished-dataset" })
    )[0];
    expect(row === undefined ? undefined : row.health).toBe("orphaned");
    const reason = row === undefined ? undefined : row.healthReason;
    expect(reason).toBeDefined();
    expect(reason).toMatch(/no longer exists/i);
    const doc = await t.query(api.derivedDatasets.get, { id });
    expect(doc === null ? undefined : doc.health).toBe("orphaned");
  });

  it("reports stale when a declared key is gone from the referenced dataset's structure", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { Other: { type: "string" } }),
      id = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId, "GrantId", "GrantId")),
      );

    const doc = await t.query(api.derivedDatasets.get, { id });
    expect(doc === null ? undefined : doc.health).toBe("stale");
    const reason = doc === null ? undefined : doc.healthReason;
    expect(reason).toBeDefined();
    expect(reason).toContain("GrantId");
  });

  it("marks a ready dependent stale when a re-import changes the source's columns", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      id = await t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(schemaId, schemaId)));

    // The spec reads a structure that still carries the key: ready.
    const before = await t.query(api.derivedDatasets.get, { id });
    expect(before === null ? undefined : before.health).toBe("ready");

    // A changed-column re-import replaces the declared structure; the same
    // row re-reads stale on its next health pass (compute-on-read).
    await t.mutation(api.schemas.update, {
      schema: { properties: { Other: { type: "string" } }, title: "Grants", type: "object" },
      schemaId,
    });

    const after = await t.query(api.derivedDatasets.get, { id });
    expect(after === null ? undefined : after.health).toBe("stale");
    const reason = after === null ? undefined : after.healthReason;
    expect(reason).toBeDefined();
    expect(reason).toContain("GrantId");
  });

  it("inherits orphaning transitively from a derived source", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      doomed = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId), { title: "Doomed" }),
      ),
      dependent = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(doomed, doomed), { title: "Dependent" }),
      );

    await t.mutation(api.derivedDatasets.remove, { id: doomed });

    const doc = await t.query(api.derivedDatasets.get, { id: dependent });
    expect(doc === null ? undefined : doc.health).toBe("orphaned");
    expect(await t.query(api.derivedDatasets.get, { id: doomed })).toBeNull();
  });
});

describe("remove", () => {
  it("deletes a row and rejects an unknown id", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      id = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId), { status: "draft" }),
      );

    expect(await t.mutation(api.derivedDatasets.remove, { id })).toBeNull();
    expect(await t.query(api.derivedDatasets.get, { id })).toBeNull();
    await expect(t.mutation(api.derivedDatasets.remove, { id })).rejects.toThrow(
      /no longer exists/i,
    );
  });
});

describe("remove cascades the row's host rows (issue #128 follow-up)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a registry-row id drains policies, attempts, deltas, source-side edges, and memberships — and the dependent survives with its edge pruned", async () => {
    const t = signedIn(),
      source = await createComponentDataset(t, { GrantId: { type: "string" } }),
      // The doomed row: a saved spec over the component source.
      doomed = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(specOf(source), { title: "Doomed" }),
      ),
      // The dependent: saved over the doomed row — its float edge names the
      // doomed id as SOURCE and its dependsOn names it too.
      dependent = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(specOf(doomed), { title: "Dependent" }),
      ),
      projectId = await t.mutation(api.projects.create, { title: "Holder" });
    // Two memberships in one project: the doomed registry row (kind
    // "derived") and its component source (kind "dataset" — whose fork edge
    // addArtifact mints in the same transaction). The cascade must drain
    // exactly one membership and leave the denormalized count honest.
    await t.mutation(api.projects.addArtifact, {
      artifactId: source,
      artifactKind: "dataset",
      projectId,
    });
    await t.mutation(api.projects.addArtifact, {
      artifactId: doomed,
      artifactKind: "derived",
      projectId,
    });
    // The doomed chain's keyed rows (direct inserts — the schemas.test.ts
    // "dataset" leg precedent): a derived chain's anchor IS the registry row,
    // so its policy/delta/attempt stores all key on it.
    await t.run(async (ctx) => {
      await ctx.db.insert("versionPolicies", { datasetKey: doomed, keepVersions: 3 });
      await ctx.db.insert("tagDeltas", {
        at: Date.now(),
        ops: [],
        sourceSchemaId: doomed,
        toRef: "pub_derived",
      });
      await ctx.db.insert("publishAttempts", {
        chunkStorageIds: [],
        createdBy: "user-1",
        datasetKey: doomed,
        datasetKind: "derived",
        lastProgressAt: Date.now(),
        publishKey: "pub_derived",
        startedAt: Date.now(),
        status: "completed",
        title: "Doomed v1",
        versionLabel: "v1",
      });
    });

    // Sanity: every row the cascade owns is there before the delete —
    // including the dependent's edge, which the remove's inline
    // by-consumer cleanup does NOT cover (its consumer is the dependent,
    // not the doomed row — only the cascade's source-side phase reaches it).
    const before = await t.run(async (ctx) => ({
      dependentEdge: await ctx.db
        .query("consumerReferences")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", doomed))
        .take(1),
      forkEdge: await ctx.db
        .query("consumerReferences")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", source))
        .take(1),
      membership: await ctx.db
        .query("projectArtifacts")
        .withIndex("by_artifact", (q) => q.eq("artifactKind", "derived").eq("artifactId", doomed))
        .take(1),
      publishAttempts: await ctx.db
        .query("publishAttempts")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", doomed))
        .take(1),
      tagDeltas: await ctx.db
        .query("tagDeltas")
        .withIndex("by_source", (q) => q.eq("sourceSchemaId", doomed))
        .take(1),
      versionPolicies: await ctx.db
        .query("versionPolicies")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", doomed))
        .take(1),
    }));
    expect(before.dependentEdge).toHaveLength(1);
    expect(before.forkEdge).toHaveLength(1);
    expect(before.membership).toHaveLength(1);
    expect(before.versionPolicies).toHaveLength(1);
    expect(before.tagDeltas).toHaveLength(1);
    expect(before.publishAttempts).toHaveLength(1);

    await t.mutation(api.derivedDatasets.remove, { id: doomed });
    // The cascade is a scheduled chain — drain it before asserting.
    await drainScheduled(t);

    const after = await t.run(async (ctx) => ({
      dependentEdge: await ctx.db
        .query("consumerReferences")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", doomed))
        .take(1),
      forkEdge: await ctx.db
        .query("consumerReferences")
        .withIndex("by_source", (q) => q.eq("sourceDatasetId", source))
        .take(1),
      membership: await ctx.db
        .query("projectArtifacts")
        .withIndex("by_artifact", (q) => q.eq("artifactKind", "derived").eq("artifactId", doomed))
        .take(1),
      publishAttempts: await ctx.db
        .query("publishAttempts")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", doomed))
        .take(1),
      tagDeltas: await ctx.db
        .query("tagDeltas")
        .withIndex("by_source", (q) => q.eq("sourceSchemaId", doomed))
        .take(1),
      versionPolicies: await ctx.db
        .query("versionPolicies")
        .withIndex("by_dataset", (q) => q.eq("datasetKey", doomed))
        .take(1),
    }));
    // Nothing keyed by the registry id survives anywhere…
    expect(after.dependentEdge).toHaveLength(0);
    expect(after.membership).toHaveLength(0);
    expect(after.publishAttempts).toHaveLength(0);
    expect(after.tagDeltas).toHaveLength(0);
    expect(after.versionPolicies).toHaveLength(0);
    // …the source dataset's OWN rows are untouched (the drain is id-keyed —
    // it never becomes a source-side sweep)…
    expect(after.forkEdge).toHaveLength(1);
    // …the project's denormalized count dropped by exactly the one drained
    // membership (2 seeded, 1 drained)…
    const project = await t.query(api.projects.get, { projectId });
    if (project === null) {
      throw new Error("the cascade deleted the holder project — it must survive");
    }
    expect(project.project.artifactCount).toBe(1);
    // …and the dependent row SURVIVES with its dead edge pruned (it re-reads
    // as orphaned through its spec — the documented dependent behavior).
    const doc = await t.query(api.derivedDatasets.get, { id: dependent });
    if (doc === null) {
      throw new Error("the cascade deleted the dependent registry row — it must survive");
    }
    expect(doc.dependsOn).toStrictEqual([]);
  });
});

describe("listBySource windowing (issue #128)", () => {
  it("foreign drafts can no longer push a visible saved row out of the take window", async () => {
    const t = signedIn(),
      schemaId = await createComponentDataset(t, { GrantId: { type: "string" } }),
      savedId = await t.mutation(api.derivedDatasets.save, saveArgs(specOf(schemaId)));
    // 210 foreign drafts over the same source — more than the read's 200-row
    // bound. The old read scanned by_source and filtered AFTER the take, so
    // these pushed every visible row out of the window.
    await t.run(async (ctx) => {
      for (let index = 0; index < 210; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
        await ctx.db.insert("derivedDatasets", {
          createdBy: "user-2",
          dependsOn: [schemaId],
          sourceDatasetId: schemaId,
          spec: { operations: [], sourceDatasetId: schemaId },
          status: "draft",
          title: `Foreign autosave ${index}`,
        });
      }
    });

    const rows = await t.query(api.derivedDatasets.listBySource, {
      sourceDatasetId: schemaId,
    });
    // The saved row (another catalog-visible leg) is STILL there…
    expect(rows.some((row) => row._id === savedId)).toBe(true);
    // …and no foreign draft leaked into the caller's list.
    expect(rows.every((row) => row.status === "saved" || row.createdBy === "user-1")).toBe(true);
  });
});

describe("summaries at the 500-row bound (issue #128 AC 3)", () => {
  it("500 saved rows over a shared source set resolve under the read limits, health included", async () => {
    const t = signedIn(),
      // Three shared sources: the memo makes the catalog's read cost
      // proportional to DISTINCT sources, not rows (the measured ceiling:
      // 500 rows over 500 DISTINCT fat schemas is the documented bound —
      // see summaries' doc comment in derivedDatasets.ts).
      sourceA = await createComponentDataset(t, { GrantId: { type: "string" } }),
      sourceB = await createComponentDataset(t, { GrantId: { type: "string" } }),
      sourceC = await createComponentDataset(t, { GrantId: { type: "string" } });
    await t.run(async (ctx) => {
      for (let index = 0; index < 500; index += 1) {
        const source = index % 3 === 0 ? sourceA : index % 3 === 1 ? sourceB : sourceC;
        // oxlint-disable-next-line no-await-in-loop -- fixture seeding, ordered.
        await ctx.db.insert("derivedDatasets", {
          createdBy: "user-1",
          dependsOn: [source],
          sourceDatasetId: source,
          spec: { operations: [], sourceDatasetId: source },
          status: "saved",
          title: `Saved spec ${index}`,
        });
      }
    });

    const rows = await t.query(api.derivedDatasets.summaries, {});
    expect(rows).toHaveLength(500);
    // Health resolved for every row without blowing the read budget (the
    // shared sources collapsed the component reads to three).
    expect(rows.every((row) => row.health === "ready")).toBe(true);
  });
});
