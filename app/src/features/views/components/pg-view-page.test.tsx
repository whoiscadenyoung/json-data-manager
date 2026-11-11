// @vitest-environment jsdom
import type { ViewDefinition } from "@caden/data-core/views";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
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
  inputs: [
    { alias: "states", ref: { kind: "dataset", id: STATES } },
    { alias: "deployments", ref: { kind: "dataset", id: DEPLOYMENTS } },
  ],
  base: "states",
  steps: [
    {
      kind: "join",
      right: { input: "deployments" },
      on: [{ left: "id", right: "stateId" }],
      matching: { trim: true, caseFold: false, collapseSpace: false, stripDiacritics: false },
      type: "left",
      multiMatch: { mode: "summarize", measures: [{ as: "deployments", fn: "count" }] },
    },
  ],
  output: { fields: [], emptyFields: "keep" },
};

const mocks = vi.hoisted(() => ({
  previewDraftView: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  runView: vi.fn<(id: string) => Promise<unknown>>(),
  saveView: vi.fn<(...args: unknown[]) => Promise<void>>(),
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

vi.mock("@/lib/store/view-reads", () => ({
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
      steps: [
        {
          index: 0,
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
  it("lists the steps, the base by title, the stale badge and the step's preview with diagnostics", async () => {
    mount();
    expect(await screen.findByText("Deployments per state")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(await screen.findByText("States")).toBeTruthy();
    expect(screen.getByText("1. Join")).toBeTruthy();
    await waitFor(() => {
      expect(mocks.previewDraftView).toHaveBeenCalled();
    });
    // The preview is requested for the selected step with a draft definition (JSON), never SQL.
    const call = mocks.previewDraftView.mock.calls[0];
    expect(call).toBeDefined();
    expect(call === undefined ? undefined : call[2]).toBe(0);
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

  it("enables Save after an edit and saves the definition with its inputs", async () => {
    mount();
    await screen.findByText("Deployments per state");
    const name = await screen.findByLabelText("Measure 1 name");
    fireEvent.change(name, { target: { value: "deployment_count" } });
    const save = screen.getByRole("button", { name: /^Save$/ });
    await waitFor(() => {
      expect(save).toHaveProperty("disabled", false);
    });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    // Run needs the saved steps: it says so.
    expect(screen.getByText(/Refresh now: Save your changes first/)).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => {
      expect(mocks.saveView).toHaveBeenCalledTimes(1);
    });
    const saved = mocks.saveView.mock.calls[0];
    expect(saved).toBeDefined();
    expect(saved === undefined ? undefined : saved[1]).toBe("v1");
    expect(JSON.stringify(saved === undefined ? undefined : saved[2])).toContain(
      "deployment_count",
    );
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

  it("names the required field when the steps are incomplete", async () => {
    mount();
    await screen.findByText("Deployments per state");
    const name = await screen.findByLabelText("Measure 1 name");
    fireEvent.change(name, { target: { value: "" } });
    expect(await screen.findByText(/Can't save yet: .*output name/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Save$/ })).toHaveProperty("disabled", true);
  });
});
