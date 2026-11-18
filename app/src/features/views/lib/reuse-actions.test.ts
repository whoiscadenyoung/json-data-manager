import type { ViewDefinition } from "@caden/data-core/views";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  createProjectView:
    vi.fn<(args: { definition: ViewDefinition; title: string }) => Promise<string>>(),
  runView: vi.fn<(id: string) => Promise<unknown>>(),
  saveView:
    vi.fn<(deps: unknown, id: string, args: { definition: ViewDefinition }) => Promise<void>>(),
}));

vi.mock("@/lib/store/views", () => ({ runView: mocks.runView, viewDeps: () => ({}) }));
vi.mock("@/lib/views/view-save", () => ({ saveView: mocks.saveView }));
vi.mock("./create-view", () => ({ createProjectView: mocks.createProjectView }));

import { explainCycle, ExtractIncompleteError, extractNodeToView } from "./reuse-actions";

const NO_MATCHING = { trim: false, caseFold: false, collapseSpace: false, stripDiacritics: false };

const definition: ViewDefinition = {
  nodes: {
    states: { kind: "source", ref: { kind: "dataset", id: "d-states" } },
    deployments: { kind: "source", ref: { kind: "dataset", id: "d-deployments" } },
    named: {
      kind: "filter",
      from: "deployments",
      where: { field: "name", op: "notNull" },
      label: "Deployments",
    },
    joined: {
      kind: "join",
      left: "states",
      right: "named",
      on: [{ left: "id", right: "stateId" }],
      matching: NO_MATCHING,
      type: "left",
      multiMatch: { mode: "summarize", measures: [{ as: "n", fn: "count" }] },
    },
  },
  result: { node: "joined", output: { fields: [], emptyFields: "keep" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.createProjectView.mockImplementation(async () => {
    mocks.calls.push("create");
    return await Promise.resolve("v-new");
  });
  mocks.runView.mockImplementation(async () => {
    mocks.calls.push("run");
    return await Promise.resolve({ status: "ok", rowCount: 4 });
  });
  mocks.saveView.mockImplementation(async () => {
    mocks.calls.push("save");
    await Promise.resolve();
  });
});

describe("extractNodeToView", () => {
  const args = {
    definition,
    newTitle: "Named deployments",
    node: "named",
    projectId: "p1",
    viewId: "v1",
  };

  it("creates the new view, runs it once, then saves the edited view", async () => {
    const outcome = await extractNodeToView(args);
    expect(mocks.calls).toEqual(["create", "run", "save"]);
    expect(outcome.newViewId).toBe("v-new");
    const created = mocks.createProjectView.mock.calls[0];
    expect(created === undefined ? undefined : created[0].definition.result.node).toBe("named");
    const saved = mocks.saveView.mock.calls[0];
    const edited = saved === undefined ? undefined : saved[2].definition;
    // The node is now a source reading the new view; deployments is pruned.
    expect(edited === undefined ? undefined : edited.nodes.named).toMatchObject({
      kind: "source",
      ref: { id: "v-new" },
    });
    expect(edited === undefined ? undefined : Object.keys(edited.nodes).toSorted()).toEqual([
      "joined",
      "named",
      "states",
    ]);
  });

  it("leaves the edited view alone when the first run fails", async () => {
    mocks.runView.mockResolvedValueOnce({ status: "error", error: "boom" });
    await expect(extractNodeToView(args)).rejects.toBeInstanceOf(ExtractIncompleteError);
    expect(mocks.saveView).not.toHaveBeenCalled();
  });
});

describe("explainCycle", () => {
  const views = [
    { id: "x", title: "Deployments by state", inputs: [{ inputDatasetId: "v1" }] },
    { id: "y", title: "Unrelated", inputs: [{ inputDatasetId: "d-states" }] },
  ];
  const cycle = new Error("saving this view would create a cycle");

  it("names the input that already reads this view", () => {
    expect(explainCycle(cycle, { inputIds: ["d-states", "x"], viewId: "v1", views })).toContain(
      '"Deployments by state" already reads this view',
    );
  });

  it("follows chains of views", () => {
    const chain = [
      { id: "x", title: "Outer", inputs: [{ inputDatasetId: "mid" }] },
      { id: "mid", title: "Middle", inputs: [{ inputDatasetId: "v1" }] },
    ];
    expect(explainCycle(cycle, { inputIds: ["x"], viewId: "v1", views: chain })).toContain(
      '"Outer" already reads this view',
    );
  });

  it("explains a view reading itself", () => {
    expect(explainCycle(cycle, { inputIds: ["v1"], viewId: "v1", views })).toMatch(/read itself/);
  });

  it("ignores other errors", () => {
    expect(explainCycle(new Error("nope"), { inputIds: ["x"], viewId: "v1", views })).toBe(
      undefined,
    );
  });
});
