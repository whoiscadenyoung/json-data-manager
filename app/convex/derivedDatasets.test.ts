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
import { describe, expect, it } from "vitest";

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

function lookupSpec(source: string, lookupDataset: string, baseKey = "GrantId", lookupKey = "GrantId") {
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
    await expect(t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec("s", "s")))).rejects.toThrow(
      GATE_MESSAGE,
    );
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

    const draftRows = await t.query(api.derivedDatasets.listBySource, { sourceDatasetId: schemaId });
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
    expect(await t.query(api.derivedDatasets.listBySource, { sourceDatasetId: first })).toStrictEqual(
      [],
    );
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
      t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(schemaId, schemaId), { title: "   " })),
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
      a = await t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(schemaId, schemaId), { title: "A" })),
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
      a = await t.mutation(api.derivedDatasets.save, saveArgs(lookupSpec(schemaId, schemaId), { title: "A" })),
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
      id = await t.mutation(
        api.derivedDatasets.save,
        saveArgs(lookupSpec(schemaId, schemaId)),
      );

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
