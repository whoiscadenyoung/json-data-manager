// @vitest-environment jsdom
import type { ViewDefinition } from "@caden/data-core/views";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    useNavigate: () => vi.fn<(args: unknown) => Promise<void>>(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

vi.mock("@caden/ui/components/code-editor", () => ({
  CodeEditor: (props: { ariaLabel: string; onChange: (v: string) => void; value: string }) =>
    createElement("textarea", {
      "aria-label": props.ariaLabel,
      onChange: (event: { target: { value: string } }) => {
        props.onChange(event.target.value);
      },
      value: props.value,
    }),
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
  saveView: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("../lib/create-view", () => ({ createProjectView: vi.fn<() => Promise<string>>() }));

vi.mock("@/lib/store/view-reads", () => ({
  listViewSummariesQueryOptions: () => ({
    queryFn: async () => [],
    queryKey: ["test:summaries"],
  }),
  distinctFieldValuesQueryOptions: () => ({ queryFn: async () => [], queryKey: ["test:distinct"] }),
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
    queryFn: async () => ({
      createdBy: "u1",
      dataVersion: 1,
      description: null,
      entryCount: 0,
      id: "v1",
      kind: "view",
      lifecycle: "draft",
      refreshMode: "manual",
      stale: false,
      title: "Deployments per state",
    }),
    queryKey: ["test:header"],
  }),
}));

vi.mock("@/lib/store/views", () => ({
  listRunsQueryOptions: () => ({ queryFn: async () => [], queryKey: ["test:runs"] }),
  previewDraftView: mocks.previewDraftView,
  runView: vi.fn<(id: string) => Promise<unknown>>(),
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
        // A sub-pipeline step reports its LOCAL index plus the path; it must not be mistaken for top-level step 0.
        {
          index: 0,
          path: "steps[0].right.steps[0]",
          kind: "groupBy",
          rowsIn: 5,
          rowsOut: 2,
          fieldsAdded: ["count"],
          fieldsRemoved: ["stateId"],
        },
        {
          index: 0,
          kind: "join",
          rowsIn: 2,
          rowsOut: 2,
          fieldsAdded: ["deployments"],
          fieldsRemoved: [],
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

describe("inline sub-pipelines", () => {
  it("adds steps to the join's right input, edits them nested, and saves them under right.steps", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add steps to this input" }));
    const group = await screen.findByRole("group", {
      name: /Steps on Deployments 2024 before joining/,
    });
    // The nested list has the same add-step menu as the main one.
    fireEvent.click(within(group).getByRole("button", { name: "Add step to this input" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Filter rows" }));
    expect(await within(group).findByText("1. Filter rows")).toBeTruthy();
    // Nested controls are labelled apart from the top-level step's.
    expect(within(group).getByLabelText("Delete sub-step 1")).toBeTruthy();
    // Its own condition, edited inside the nested step.
    fireEvent.change(within(group).getByLabelText("Condition 1 value"), {
      target: { value: "NASA" },
    });
    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeTruthy();
    });
    const save = screen.getByRole("button", { name: /^Save$/ });
    await waitFor(() => {
      expect(screen.getByTestId("action-reasons").textContent).not.toMatch(/Save:/);
    });
    fireEvent.click(save);
    await waitFor(() => {
      expect(mocks.saveView).toHaveBeenCalledTimes(1);
    });
    const saved = mocks.saveView.mock.calls[0];
    const payload = JSON.parse(JSON.stringify(saved === undefined ? undefined : saved[2]));
    expect(payload.definition.steps[0].right.steps).toEqual([
      { kind: "filter", where: { field: "id", op: "eq", value: "NASA" } },
    ]);
    // The right side is still the declared input (never the dataset id).
    expect(payload.definition.steps[0].right.input).toBe("deployments");
  });

  it("shows a validation error on the nested step and field it belongs to, and explains the blocked Save", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add steps to this input" }));
    const group = await screen.findByRole("group", {
      name: /Steps on Deployments 2024 before joining/,
    });
    fireEvent.click(within(group).getByRole("button", { name: "Add step to this input" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Group and summarize" }));
    // Grouping keeps only id and count, so the join's key "stateId" no longer exists on the right.
    expect(await screen.findByText(/Key pair 1 \(right\): Unknown field "stateId"/)).toBeTruthy();
    expect(screen.getByText(/Save: Can't save yet: Unknown field "stateId"/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Save$/ })).toHaveProperty("disabled", true);
  });

  it("removes the nested steps again", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add steps to this input" }));
    await screen.findByRole("group", { name: /Steps on Deployments 2024 before joining/ });
    fireEvent.click(screen.getByRole("button", { name: "Remove these steps" }));
    expect(await screen.findByRole("button", { name: "Add steps to this input" })).toBeTruthy();
  });
});
