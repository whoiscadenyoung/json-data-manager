// @vitest-environment jsdom
import type { ViewDefinition } from "@caden/data-core/views";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode; className?: string; to?: string }) =>
      createElement("a", { className: props.className, "data-to": props.to }, props.children),
    useNavigate: () => vi.fn<(args: unknown) => Promise<void>>(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

const STATES = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENTS = "22222222-2222-4222-8222-222222222222";

const definition: ViewDefinition = {
  nodes: {
    states: { kind: "source", ref: { kind: "dataset", id: STATES } },
    deployments: { kind: "source", ref: { kind: "dataset", id: DEPLOYMENTS } },
    joined: {
      kind: "join",
      label: "Join",
      left: "states",
      right: "deployments",
      on: [{ left: "id", right: "stateId" }],
      matching: { trim: true, caseFold: false, collapseSpace: false, stripDiacritics: false },
      type: "left",
      multiMatch: { mode: "summarize", measures: [{ as: "deployments", fn: "count" }] },
    },
  },
  result: { node: "joined", output: { fields: [], emptyFields: "keep" } },
};

const mocks = vi.hoisted(() => ({
  previewDraftView: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  runView: vi.fn<(id: string) => Promise<unknown>>(),
  saveView: vi.fn<(...args: unknown[]) => Promise<void>>(),
  summaries: [] as unknown[],
  setViewRefreshMode: vi.fn<(id: string, mode: string) => Promise<void>>(),
  queue: null as { dueAt: string; running: boolean } | null,
  header: {
    createdBy: "u1",
    dataVersion: 1,
    description: null,
    entryCount: 0,
    id: "v1",
    kind: "view",
    lifecycle: "draft",
    refreshMode: "manual",
    stale: true,
    title: "Deployments per state",
  } as Record<string, unknown>,
}));

// The canvas is React Flow (needs a measured DOM): draw the same graph as plain buttons.
vi.mock("@/features/view-graphs", async () => await import("./test-node-graph"));

vi.mock("../lib/create-view", () => ({ createProjectView: vi.fn<() => Promise<string>>() }));

vi.mock("@/lib/store/view-reads", () => ({
  listViewSummariesQueryOptions: () => ({
    queryFn: async () => mocks.summaries,
    queryKey: ["test:summaries"],
  }),
  inputMetaQueryOptions: (inputs: unknown[]) => ({
    queryFn: async () => [
      { alias: "states", datasetId: STATES, title: "States", fields: ["id", "name"] },
      {
        alias: "deployments",
        datasetId: DEPLOYMENTS,
        title: "Deployments 2024",
        fields: ["id", "stateId"],
      },
    ],
    queryKey: ["test:inputMeta", inputs],
  }),
  savedDefinitionQueryOptions: () => ({
    queryFn: async () => ({
      definition,
      inputs: [],
      outputSettings: null,
      refreshMode: "manual",
    }),
    queryKey: ["test:definition"],
  }),
  viewHeaderQueryOptions: () => ({
    queryFn: async () => mocks.header,
    queryKey: ["test:header"],
  }),
}));

vi.mock("@/lib/store/views", () => ({
  listRunsQueryOptions: () => ({ queryFn: async () => [], queryKey: ["test:runs"] }),
  previewDraftView: mocks.previewDraftView,
  refreshQueueQueryOptions: () => ({
    queryFn: async () => mocks.queue,
    queryKey: ["test:queue"],
  }),
  runView: mocks.runView,
  setViewRefreshMode: mocks.setViewRefreshMode,
  viewDeps: () => ({}),
}));

vi.mock("@/lib/views/view-save", () => ({ saveView: mocks.saveView }));

vi.mock("@/lib/store/projects", () => ({
  listVisibleArtifactMembershipsQueryOptions: () => ({
    queryKey: ["pg:projects", "listVisibleArtifactMemberships"],
    queryFn: async () => [],
  }),
}));
vi.mock("@/lib/store/datasets", () => ({
  listQueryOptions: () => ({
    queryFn: async () => [
      { id: STATES, kind: "source", title: "States" },
      { id: DEPLOYMENTS, kind: "source", title: "Deployments 2024" },
    ],
    queryKey: ["test:datasets"],
  }),
}));

import { PgViewPage } from "./pg-view-page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  mocks.previewDraftView.mockResolvedValue({
    diagnostics: {
      nodes: [
        {
          id: "joined",
          kind: "join",
          rowsIn: 2,
          rowsOut: 2,
          fieldsAdded: ["deployments"],
          fieldsRemoved: [],
          join: {
            leftMatched: 1,
            leftUnmatched: 1,
            leftUnmatchedSamples: ["Alabama "],
            rightMatched: 3,
            rightUnmatched: 0,
            rightUnmatchedSamples: [],
            multiMatchKeys: 1,
            policy: "summarize",
          },
        },
      ],
    },
    rows: [{ d: { name: "Kansas", deployments: 3 }, geom: null, row_id: "r1" }],
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(PgViewPage, { projectId: "p1", viewId: "v1" }),
    ),
  );
}

describe("PgViewPage (view editor)", () => {
  it("lists the nodes, the source by title, the stale badge and the node's preview with diagnostics", async () => {
    mount();
    expect(await screen.findByText("Deployments per state")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    // The canvas draws the source by title and the node; the settings panel opens the selected node.
    const canvas = screen.getByTestId("node-canvas");
    expect(await within(canvas).findByText("States")).toBeTruthy();
    expect(within(canvas).getByText("Join")).toBeTruthy();
    const settings = screen.getByRole("complementary", { name: "Node settings" });
    expect(within(settings).getByText("joined")).toBeTruthy();
    await waitFor(() => {
      expect(mocks.previewDraftView).toHaveBeenCalled();
    });
    // The preview is requested for the selected node's subgraph (JSON), never SQL.
    const call = mocks.previewDraftView.mock.calls[0];
    expect(JSON.stringify(call === undefined ? undefined : call[0])).toContain(
      '"result":{"node":"joined"',
    );
    expect(await screen.findByText("Kansas")).toBeTruthy();
    expect(await screen.findByText(/rows here matched/)).toBeTruthy();
  });

  it("explains why Save and Refresh now are unavailable instead of staying silently disabled", async () => {
    mount();
    await screen.findByText("Deployments per state");
    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save).toHaveProperty("disabled", true);
    expect(screen.getByText(/Save: No changes to save/)).toBeTruthy();
  });

  it("enables Save after an edit and saves the definition with its sources", async () => {
    mount();
    await screen.findByText("Deployments per state");
    const name = await screen.findByLabelText("Measure 1 name");
    fireEvent.change(name, { target: { value: "deployment_count" } });
    const save = screen.getByRole("button", { name: /^Save$/ });
    await waitFor(() => {
      expect(save).toHaveProperty("disabled", false);
    });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    // Run needs the saved nodes: it says so.
    expect(screen.getByText(/Refresh now: Save your changes first/)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => {
      expect(mocks.saveView).toHaveBeenCalledTimes(1);
    });
    const saved = mocks.saveView.mock.calls[0];
    expect(saved).toBeDefined();
    expect(saved === undefined ? undefined : saved[1]).toBe("v1");
    const sent = JSON.stringify(saved === undefined ? undefined : saved[2]);
    expect(sent).toContain("deployment_count");
    expect(sent).toContain('"alias":"deployments"');
  });

  it("shows the refresh mode picker with an explanation of the current mode", async () => {
    mount();
    await screen.findByText("Deployments per state");
    expect(screen.getByLabelText("Refresh mode")).toBeTruthy();
    expect(screen.getByText(/Rows are saved when you press Refresh now/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Refresh now/ })).toBeTruthy();
  });

  it("switches to live through the picker and says live is computed on read", async () => {
    mocks.setViewRefreshMode.mockResolvedValue(undefined);
    mount();
    await screen.findByText("Deployments per state");
    const trigger = screen.getByLabelText("Refresh mode");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    const live = await screen.findByRole("option", { name: "Live" });
    live.focus();
    fireEvent.keyDown(live, { key: "Enter" });
    fireEvent.keyUp(live, { key: "Enter" });
    fireEvent.click(live);
    await waitFor(() => {
      expect(mocks.setViewRefreshMode).toHaveBeenCalledWith("v1", "live");
    });
  });

  it("an auto view shows when its next refresh is queued and who it runs as", async () => {
    mocks.header["refreshMode"] = "auto";
    mocks.header["autoRefreshBy"] = "u1";
    mocks.queue = { dueAt: new Date(Date.now() + 40_000).toISOString(), running: false };
    try {
      mount();
      expect(await screen.findByTestId("refresh-queued")).toBeTruthy();
      expect(screen.getByTestId("refresh-queued").textContent).toMatch(
        /Next refresh queued, in \d+ seconds/,
      );
      expect(screen.getByText(/Runs as the view's creator/)).toBeTruthy();
    } finally {
      mocks.header["refreshMode"] = "manual";
      mocks.header["autoRefreshBy"] = null;
      mocks.queue = null;
    }
  });

  it("a live view says it computes on read and Refresh now only re-reads", async () => {
    mocks.header["refreshMode"] = "live";
    try {
      mount();
      expect(await screen.findByText("Computed on read")).toBeTruthy();
      expect(screen.getByText(/computed from the inputs every time they are read/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Refresh now/ }));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Refresh now/ })).toHaveProperty(
          "disabled",
          false,
        );
      });
      expect(mocks.runView).not.toHaveBeenCalled();
    } finally {
      mocks.header["refreshMode"] = "manual";
    }
  });

  it("names the required field when the nodes are incomplete", async () => {
    mount();
    await screen.findByText("Deployments per state");
    const name = await screen.findByLabelText("Measure 1 name");
    fireEvent.change(name, { target: { value: "" } });
    expect(await screen.findByText(/Can't save yet: .*output name/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Save$/ })).toHaveProperty("disabled", true);
  });

  it("explains a cycle error from Save in plain words, naming the view that reads this one", async () => {
    mocks.summaries = [
      {
        id: DEPLOYMENTS,
        inputs: [{ alias: "me", inputDatasetId: "v1" }],
        title: "Deployments 2024",
      },
    ];
    mocks.saveView.mockRejectedValueOnce(new Error("saving this view would create a cycle"));
    mount();
    await screen.findByText("Deployments per state");
    fireEvent.change(await screen.findByLabelText("Measure 1 name"), {
      target: { value: "n" },
    });
    const save = screen.getByRole("button", { name: /^Save$/ });
    await waitFor(() => {
      expect(save).toHaveProperty("disabled", false);
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('"Deployments 2024" already reads this view'),
      );
    });
    mocks.summaries = [];
  });

  it("flags a join that left rows unmatched on its canvas node", async () => {
    mount();
    const canvas = await screen.findByTestId("node-canvas");
    await waitFor(() => {
      expect(within(canvas).getByText("Join").getAttribute("data-badge")).toBe("1 unmatched");
    });
  });

  it("appends a node from the canvas toolbar and opens its settings", async () => {
    mount();
    const canvas = await screen.findByTestId("node-canvas");
    await within(canvas).findByText("States");
    fireEvent.click(screen.getByRole("button", { name: "Add node: Filter rows" }));
    expect(await within(canvas).findByText("Filter rows")).toBeTruthy();
    const settings = screen.getByRole("complementary", { name: "Node settings" });
    expect(within(settings).getByText("filter_rows")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    // It reads the old result and became the new one.
    expect(within(settings).queryByText("Result")).not.toBeNull();
  });

  it("inserts a node on a connection, between a source and its reader", async () => {
    mount();
    const canvas = await screen.findByTestId("node-canvas");
    await within(canvas).findByText("States");
    fireEvent.click(within(canvas).getByRole("button", { name: "Insert a node: States to Join" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Calculate fields" }));
    expect(await within(canvas).findByText("Calculate")).toBeTruthy();
    expect(within(canvas).getByText("Join")).toBeTruthy();
  });

  it("selects the output from the canvas and shows its fields in the settings panel", async () => {
    mount();
    const canvas = await screen.findByTestId("node-canvas");
    fireEvent.click(within(canvas).getByText("Output"));
    const settings = screen.getByRole("complementary", { name: "Node settings" });
    expect(await within(settings).findByText("Output fields")).toBeTruthy();
  });

  it("keeps run history and exports behind tabs in the docked panel, which collapses", async () => {
    mount();
    await screen.findByTestId("node-canvas");
    expect(screen.queryByText(/The last 50 runs/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Run history" }));
    expect(await screen.findByText(/The last 50 runs/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse the details panel" }));
    expect(screen.queryByText(/The last 50 runs/)).toBeNull();
    // Picking a tab opens the panel again.
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(await screen.findByText("Kansas")).toBeTruthy();
  });

  it("outlines the whole view in dependency order and selects from the outline", async () => {
    mount();
    const outline = await screen.findByRole("navigation", { name: "Node outline" });
    await within(outline).findAllByText("States");
    const rows = within(outline)
      .getAllByRole("button")
      .map((row) => row.textContent);
    expect(rows[0]).toMatch(/States/);
    expect(rows[1]).toMatch(/Deployments 2024/);
    expect(rows[2]).toMatch(/Join/);
    expect(rows[3]).toMatch(/Output/);
    // The selected node is marked; selecting the output moves the mark and the settings.
    expect(within(outline).getByText("Join").closest("button")).toHaveProperty(
      "ariaCurrent",
      "true",
    );
    fireEvent.click(within(outline).getByText("Output"));
    const settings = screen.getByRole("complementary", { name: "Node settings" });
    expect(await within(settings).findByText("Output fields")).toBeTruthy();
  });

  it("previews a source's own rows when its node is clicked, and describes it in the settings panel", async () => {
    mount();
    const canvas = await screen.findByTestId("node-canvas");
    fireEvent.click(await within(canvas).findByText("Deployments 2024"));
    // The preview is requested for that source alone: one node.
    await waitFor(() => {
      const sent = mocks.previewDraftView.mock.calls.map((call) => JSON.stringify(call[0]));
      expect(sent).toContain(
        JSON.stringify({
          nodes: { deployments: { kind: "source", ref: { kind: "dataset", id: DEPLOYMENTS } } },
          result: { node: "deployments", output: { fields: [], emptyFields: "keep" } },
        }),
      );
    });
    expect(
      (await screen.findAllByText("Deployments 2024", { selector: "h2" })).length,
    ).toBeGreaterThan(0);
    const settings = screen.getByRole("complementary", { name: "Node settings" });
    expect(within(settings).getAllByText("Read by Join").length).toBeGreaterThan(0);
    expect(within(settings).getByText("Open this dataset")).toBeTruthy();
  });

  it("marks sources nothing reads as Unused in the Sources panel", async () => {
    mount();
    await screen.findByText("Deployments per state");
    const sources = screen.getByRole("region", { name: "Sources" });
    expect(within(sources).getAllByText(/Read by Join/).length).toBe(2);
  });

  it("offers Duplicate in the header", async () => {
    mount();
    await screen.findByText("Deployments per state");
    fireEvent.click(screen.getByRole("button", { name: /Duplicate/ }));
    expect(await screen.findByText("Duplicate view")).toBeTruthy();
  });
});
