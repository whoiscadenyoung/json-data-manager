// @vitest-environment jsdom
import type { JoinNode, ViewDefinition } from "@caden/data-core/views";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// Links render as plain anchors; routing is not the subject here.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode; className?: string; to?: string }) =>
      createElement("a", { className: props.className, "data-to": props.to }, props.children),
    useNavigate: () => vi.fn<(args: unknown) => Promise<void>>(),
  };
});

import { nodeDiagnosticsOf } from "../lib/diagnostics";
import { newNode, type InputInfo } from "../lib/view-model";
import type { NodeEditorContext } from "./node-context";
import { JoinForm } from "./node-forms";
import { PreviewPane } from "./preview-pane";

afterEach(() => {
  cleanup();
});

const infos: InputInfo[] = [
  { alias: "states", datasetId: "d-states", title: "States", fields: ["id", "name"] },
  {
    alias: "deployments",
    datasetId: "d-deployments",
    title: "Deployments 2024",
    fields: ["id", "stateId", "cost"],
  },
];

const definition: ViewDefinition = {
  nodes: {
    states: { kind: "source", ref: { kind: "dataset", id: "d-states" } },
    deployments: { kind: "source", ref: { kind: "dataset", id: "d-deployments" } },
  },
  result: { node: "states", output: { fields: [], emptyFields: "keep" } },
};

const ctx: NodeEditorContext = {
  definition,
  diagnostics: undefined,
  errors: [],
  fields: new Map([
    ["states", ["id", "name"]],
    ["deployments", ["id", "stateId", "cost"]],
  ]),
  infos,
};

function join(overrides: Partial<JoinNode> = {}): JoinNode {
  return {
    ...(newNode("join", "states", "id") as JoinNode),
    on: [{ left: "id", right: "stateId" }],
    prefix: "deployments_2024",
    right: "deployments",
    ...overrides,
  };
}

function firstCall(spy: { mock: { calls: JoinNode[][] } }): JoinNode {
  const call = spy.mock.calls[0];
  if (call === undefined || call[0] === undefined) {
    throw new Error("onChange was not called");
  }
  return call[0];
}

describe("JoinForm", () => {
  const baseProps = {
    ctx,
    id: "joined",
    onPickRight: vi.fn<(id: string) => void>(),
  };

  it("shows the right node by title (never its id) and the default prefix", () => {
    render(
      createElement(JoinForm, {
        ...baseProps,
        onChange: vi.fn<(s: JoinNode) => void>(),
        step: join(),
      }),
    );
    expect(screen.getByText("Deployments 2024")).toBeTruthy();
    expect(screen.queryByText("d-deployments")).toBeNull();
    const prefix = screen.getByLabelText("Name prefix for joined fields");
    expect(prefix).toHaveProperty("value", "deployments_2024");
  });

  it("toggles key matching options into the step", () => {
    const onChange = vi.fn<(s: JoinNode) => void>();
    render(createElement(JoinForm, { ...baseProps, onChange, step: join() }));
    fireEvent.click(screen.getByText("Ignore case"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = firstCall(onChange);
    expect(next.matching.caseFold).toBe(true);
    expect(next.matching.trim).toBe(true);
  });

  it("offers measures for a summarize policy and a remove button per key pair", () => {
    const step = join({
      multiMatch: { mode: "summarize", measures: [{ as: "deployments", fn: "count" }] },
    });
    render(
      createElement(JoinForm, { ...baseProps, onChange: vi.fn<(s: JoinNode) => void>(), step }),
    );
    expect(screen.getByLabelText("Measure 1 name")).toHaveProperty("value", "deployments");
    expect(screen.queryByLabelText("Name prefix for joined fields")).toBeNull();
    expect(screen.getByLabelText("Remove key pair 1")).toBeTruthy();
  });

  it("lists manual key-map entries and removes one", () => {
    const onChange = vi.fn<(s: JoinNode) => void>();
    const step = join();
    render(
      createElement(JoinForm, {
        ...baseProps,
        onChange,
        step: {
          ...step,
          matching: { ...step.matching, manualMap: [{ from: "AL", to: "Alabama" }] },
        },
      }),
    );
    fireEvent.click(screen.getByLabelText("Remove map entry AL"));
    expect(firstCall(onChange).matching.manualMap).toBeUndefined();
  });
});

describe("PreviewPane diagnostics", () => {
  const diagnostics = nodeDiagnosticsOf(
    {
      nodes: [
        {
          id: "joined",
          kind: "join",
          rowsIn: 50,
          rowsOut: 50,
          fieldsAdded: ["deployments"],
          fieldsRemoved: [],
          join: {
            leftMatched: 48,
            leftUnmatched: 2,
            leftUnmatchedSamples: ["Alabama "],
            rightMatched: 100,
            rightUnmatched: 1,
            rightUnmatchedSamples: ["alabama"],
            multiMatchKeys: 40,
            policy: "summarize",
          },
        },
      ],
    },
    "joined",
  );

  function pane(onAddToKeyMap: (from: string, to: string) => void, canMap = true) {
    return createElement(PreviewPane, {
      blockedReason: undefined,
      canMap,
      diagnostics,
      error: undefined,
      isLoading: false,
      mapDisabledReason: "Select a join node.",
      onAddToKeyMap,
      rows: [{ d: { name: "Kansas", deployments: 14 } }],
      title: "Joined",
    });
  }

  it("renders rows in and out, fields added, join matched/unmatched on both sides, multi-match and policy", () => {
    render(pane(vi.fn<(from: string, to: string) => void>()));
    expect(screen.getByText(/50 rows in, 50 rows out/)).toBeTruthy();
    expect(screen.getByText("deployments", { selector: "div span, span" })).toBeTruthy();
    expect(screen.getByText(/rows here matched/)).toBeTruthy();
    expect(screen.getByText(/rows there matched/)).toBeTruthy();
    expect(screen.getByText(/keys have several matches/)).toBeTruthy();
    expect(screen.getByText("summarize")).toBeTruthy();
    expect(screen.getByText("Kansas")).toBeTruthy();
  });

  it("adds an unmatched left sample to the key map with the chosen value", () => {
    const onAdd = vi.fn<(from: string, to: string) => void>();
    render(pane(onAdd));
    fireEvent.click(screen.getByText("Add to key map"));
    const input = screen.getByLabelText("Or type the value it should match");
    fireEvent.change(input, { target: { value: "Alabama" } });
    fireEvent.click(screen.getByText("Add"));
    expect(onAdd).toHaveBeenCalledWith("Alabama ", "Alabama");
  });

  it("disables Add to key map with a reason when the step is not a single-key join", () => {
    render(pane(vi.fn<(from: string, to: string) => void>(), false));
    const button = screen.getByText("Add to key map");
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("title")).toBe("Select a join node.");
  });

  it("explains why there is no preview instead of staying blank", () => {
    render(
      createElement(PreviewPane, {
        blockedReason: "joined: Pick the key fields on both sides.",
        canMap: false,
        diagnostics: undefined,
        error: undefined,
        isLoading: false,
        mapDisabledReason: undefined,
        onAddToKeyMap: vi.fn<(a: string, b: string) => void>(),
        rows: undefined,
        title: "Result",
      }),
    );
    expect(screen.getByText(/Pick the key fields on both sides/)).toBeTruthy();
  });
});
