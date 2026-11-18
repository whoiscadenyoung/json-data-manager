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
    useNavigate: () => vi.fn<(args: unknown) => Promise<void>>(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

// base-ui Select options don't fire in jsdom: a native select stands in for the picker.
vi.mock("./labeled-select", () => ({
  LabeledSelect: (props: {
    ariaLabel: string;
    onChange: (value: string) => void;
    options: { value: string; label: string; group?: string }[];
    value: string;
  }) =>
    createElement(
      "select",
      {
        "aria-label": props.ariaLabel,
        onChange: (event: { target: { value: string } }) => {
          props.onChange(event.target.value);
        },
        value: props.value,
      },
      props.options.map((option) =>
        createElement(
          "option",
          { "data-group": option.group, key: option.value, value: option.value },
          option.label,
        ),
      ),
    ),
}));

const STATES = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENTS = "22222222-2222-4222-8222-222222222222";
const PROVINCES = "33333333-3333-4333-8333-333333333333";
const BAD = "44444444-4444-4444-8444-444444444444";
const A_VIEW = "55555555-5555-4555-8555-555555555555";

const definition: ViewDefinition = {
  nodes: {
    states: { kind: "source", ref: { kind: "dataset", id: STATES } },
    deployments: { kind: "source", ref: { kind: "dataset", id: DEPLOYMENTS } },
    joined: {
      kind: "join",
      left: "states",
      right: "deployments",
      on: [{ left: "id", right: "stateId" }],
      matching: { trim: true, caseFold: false, collapseSpace: false, stripDiacritics: false },
      type: "left",
      multiMatch: { mode: "summarize", measures: [{ as: "deployments", fn: "count" }] },
    },
  },
  result: {
    node: "joined",
    output: { fields: [{ key: "name", label: "State" }], emptyFields: "keep" },
  },
};

const catalog: Record<string, { title: string; fields: string[] }> = {
  [STATES]: { title: "States", fields: ["id", "name"] },
  [DEPLOYMENTS]: { title: "Deployments", fields: ["id", "stateId"] },
  [PROVINCES]: { title: "Provinces", fields: ["id", "name", "region"] },
  [BAD]: { title: "Odd table", fields: ["code", "label"] },
  [A_VIEW]: { title: "States view", fields: ["id", "name"] },
};

const mocks = vi.hoisted(() => ({
  createProjectView: vi.fn<(args: unknown) => Promise<string>>(),
}));

vi.mock("../lib/create-view", () => ({ createProjectView: mocks.createProjectView }));

vi.mock("@/lib/store/view-reads", () => ({
  inputMetaQueryOptions: (inputs: { alias: string; datasetId: string }[]) => ({
    queryFn: async () =>
      await Promise.resolve(
        inputs.map((input) => {
          const known = catalog[input.datasetId];
          return {
            alias: input.alias,
            datasetId: input.datasetId,
            title: known === undefined ? null : known.title,
            fields: known === undefined ? [] : known.fields,
          };
        }),
      ),
    queryKey: ["test:inputMeta", inputs],
    enabled: inputs.length > 0,
  }),
  savedDefinitionQueryOptions: () => ({
    queryFn: async () =>
      await Promise.resolve({
        definition,
        inputs: [],
        outputSettings: null,
        refreshMode: "auto",
      }),
    queryKey: ["test:definition"],
  }),
}));

import { DuplicateViewDialog } from "./duplicate-view-dialog";
import type { NodeEditorContext } from "./node-context";
import { NodeForm } from "./node-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const datasets = [
  { id: STATES, kind: "source" as const, title: "States" },
  { id: DEPLOYMENTS, kind: "source" as const, title: "Deployments" },
  { id: PROVINCES, kind: "source" as const, title: "Provinces" },
  { id: BAD, kind: "source" as const, title: "Odd table" },
  { id: A_VIEW, kind: "view" as const, title: "States view" },
];

function mountDuplicate() {
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(DuplicateViewDialog, {
        datasets,
        onOpenChange: vi.fn<(open: boolean) => void>(),
        open: true,
        projectId: "p1",
        title: "States enriched",
        viewId: "v1",
      }),
    ),
  );
}

describe("DuplicateViewDialog", () => {
  it("prefills '<title> (copy)', groups datasets and views, and creates a manual-refresh copy", async () => {
    mocks.createProjectView.mockResolvedValue("v2");
    mountDuplicate();
    const title = await screen.findByLabelText(/^Title/);
    expect(title).toHaveProperty("value", "States enriched (copy)");
    const picker = await screen.findByLabelText("Input States");
    const groups = [...picker.querySelectorAll("option")].map((o) => o.getAttribute("data-group"));
    expect(groups).toContain("Views");
    expect(groups).toContain("Datasets");
    const create = screen.getByRole("button", { name: "Create copy" });
    await waitFor(() => {
      expect(create).toHaveProperty("disabled", false);
    });
    fireEvent.click(create);
    await waitFor(() => {
      expect(mocks.createProjectView).toHaveBeenCalledTimes(1);
    });
    const [call] = mocks.createProjectView.mock.calls;
    const args = call === undefined ? undefined : (call[0] as Record<string, unknown>);
    expect(args).toMatchObject({ projectId: "p1", title: "States enriched (copy)" });
    // Labels ride along; a refresh mode is never passed (the copy is manual, not "auto").
    expect(JSON.stringify(args)).toContain('"label":"State"');
    expect(JSON.stringify(args)).not.toContain("refreshMode");
    expect(JSON.stringify(args)).not.toContain("auto");
  });

  it("lists the missing fields per step for an incompatible input and blocks Create", async () => {
    mountDuplicate();
    const picker = await screen.findByLabelText("Input States");
    fireEvent.change(picker, { target: { value: BAD } });
    const problems = await screen.findByTestId("remap-problems");
    expect(problems.textContent).toMatch(/joined/);
    expect(problems.textContent).toMatch(/id/);
    expect(screen.getByRole("button", { name: "Create copy" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Fix the problems above/)).toBeTruthy();
  });

  it("accepts a compatible input and creates the copy over it", async () => {
    mocks.createProjectView.mockResolvedValue("v2");
    mountDuplicate();
    fireEvent.change(await screen.findByLabelText("Input States"), {
      target: { value: PROVINCES },
    });
    expect(await screen.findByTestId("remap-ok")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create copy" });
    await waitFor(() => {
      expect(create).toHaveProperty("disabled", false);
    });
    fireEvent.click(create);
    await waitFor(() => {
      expect(mocks.createProjectView).toHaveBeenCalledTimes(1);
    });
    expect(JSON.stringify(mocks.createProjectView.mock.calls[0])).toContain(PROVINCES);
  });
});

describe("Extract to view button", () => {
  const filtered: ViewDefinition = {
    ...definition,
    nodes: {
      ...definition.nodes,
      named: { kind: "filter", from: "deployments", where: { field: "name", op: "notNull" } },
    },
  };
  const infos = [
    { alias: "states", datasetId: STATES, title: "States", fields: ["id", "name"] },
    {
      alias: "deployments",
      datasetId: DEPLOYMENTS,
      title: "Deployments",
      fields: ["id", "stateId", "name"],
    },
  ];
  const ctx: NodeEditorContext = {
    definition: filtered,
    diagnostics: undefined,
    errors: [],
    fields: new Map([
      ["states", ["id", "name"]],
      ["deployments", ["id", "stateId", "name"]],
      ["named", ["id", "stateId", "name"]],
    ]),
    infos,
  };

  function mountForm(extractBlocked: string | undefined, onExtract = vi.fn<() => void>()) {
    render(
      createElement(NodeForm, {
        ctx,
        extractBlocked,
        id: "named",
        isResult: false,
        onBranch: vi.fn<(kind: string) => void>(),
        onChange: vi.fn<(node: unknown) => void>(),
        onExtract,
        onMakeResult: vi.fn<() => void>(),
        onRemove: vi.fn<() => void>(),
      }),
    );
    return onExtract;
  }

  it("reports the extract request for the node", () => {
    const onExtract = mountForm(undefined);
    fireEvent.click(screen.getByRole("button", { name: /Extract to view/ }));
    expect(onExtract).toHaveBeenCalledTimes(1);
  });

  it("is disabled with its reason while the nodes have problems", () => {
    mountForm("Fix the nodes first: nope");
    const button = screen.getByRole("button", { name: /Extract to view/ });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toBe("Fix the nodes first: nope");
  });

  it("offers the graph actions: branch, use as result, remove with a reconnect", () => {
    mountForm(undefined);
    expect(screen.getByRole("button", { name: /Branch from here/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use as the result/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove named" })).toHaveProperty("disabled", false);
  });
});
