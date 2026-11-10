// @vitest-environment jsdom
import type { JoinStep } from "@caden/data-core/views";
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

import type { ViewLatestRun, ViewSummary } from "@/lib/store/view-reads";

import { stepDiagnosticsOf } from "../lib/diagnostics";
import { newJoinStep, type InputInfo } from "../lib/view-model";
import { PreviewPane } from "./preview-pane";
import { ViewCard } from "./project-views-section";
import { JoinForm } from "./step-forms";

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

function summary(overrides: Partial<ViewSummary> = {}): ViewSummary {
  return {
    bbox: null,
    createdAt: "2026-11-10T00:00:00Z",
    createdBy: "u1",
    description: null,
    editPolicy: "open",
    entryCount: 0,
    fieldCount: 0,
    featureCount: 0,
    geometryType: null,
    groupId: null,
    id: "v1",
    inputs: [
      { alias: "states", inputDatasetId: "d-states" },
      { alias: "deployments", inputDatasetId: "d-deployments" },
    ],
    isGeospatial: false,
    kind: "view",
    lifecycle: "draft",
    lineage: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveBytes: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileCacheVersion: 0,
    refreshMode: "manual",
    source: null,
    stale: false,
    title: "Deployments per state",
    visibility: "members",
    ...overrides,
  };
}

describe("ViewCard (catalog Views section)", () => {
  it("shows refresh mode, input count, input titles and 'Never run'", () => {
    render(
      createElement(ViewCard, {
        inputTitles: ["States", "Deployments 2024"],
        lastRun: undefined,
        projectId: "p1",
        view: summary({ stale: true }),
      }),
    );
    expect(screen.getByText("Deployments per state")).toBeTruthy();
    expect(screen.getByText("manual")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText(/Never run/)).toBeTruthy();
    expect(screen.getByText(/2 inputs \(States, Deployments 2024\)/)).toBeTruthy();
  });

  it("shows an Error badge (not Stale) when the last run failed, and the last-run age otherwise", () => {
    const failed: ViewLatestRun = {
      error: "boom",
      finishedAt: new Date().toISOString(),
      rowCount: null,
      status: "error",
      viewId: "v1",
    };
    const { rerender } = render(
      createElement(ViewCard, {
        inputTitles: [],
        lastRun: failed,
        projectId: "p1",
        view: summary({ stale: true }),
      }),
    );
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.queryByText("Stale")).toBeNull();
    rerender(
      createElement(ViewCard, {
        inputTitles: [],
        lastRun: { ...failed, status: "ok", error: null },
        projectId: "p1",
        view: summary(),
      }),
    );
    expect(screen.getByText(/Last run just now/)).toBeTruthy();
  });
});

function join(overrides: Partial<JoinStep> = {}): JoinStep {
  return {
    ...newJoinStep({
      left: "id",
      right: "stateId",
      rightAlias: "deployments",
      rightTitle: "Deployments 2024",
    }),
    ...overrides,
  };
}

describe("JoinForm", () => {
  const baseProps = {
    datasets: [
      { id: "d-states", title: "States" },
      { id: "d-deployments", title: "Deployments 2024" },
    ],
    infos,
    leftFields: ["id", "name"],
    onPickRight: vi.fn<(id: string) => void>(),
  };

  it("shows the right dataset by title (never its id) and the default prefix", () => {
    render(
      createElement(JoinForm, {
        ...baseProps,
        onChange: vi.fn<(s: JoinStep) => void>(),
        step: join(),
      }),
    );
    expect(screen.getByText("Deployments 2024")).toBeTruthy();
    expect(screen.queryByText("d-deployments")).toBeNull();
    const prefix = screen.getByLabelText("Name prefix for joined fields");
    expect(prefix).toHaveProperty("value", "deployments_2024");
  });

  it("toggles key matching options into the step", () => {
    const onChange = vi.fn<(s: JoinStep) => void>();
    render(createElement(JoinForm, { ...baseProps, onChange, step: join() }));
    fireEvent.click(screen.getByText("Ignore case"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0];
    expect(next?.matching.caseFold).toBe(true);
    expect(next?.matching.trim).toBe(true);
  });

  it("offers measures for a summarize policy and a remove button per key pair", () => {
    const step = join({
      multiMatch: { mode: "summarize", measures: [{ as: "deployments", fn: "count" }] },
    });
    render(
      createElement(JoinForm, { ...baseProps, onChange: vi.fn<(s: JoinStep) => void>(), step }),
    );
    expect(screen.getByLabelText("Measure 1 name")).toHaveProperty("value", "deployments");
    expect(screen.queryByLabelText("Name prefix for joined fields")).toBeNull();
    expect(screen.getByLabelText("Remove key pair 1")).toBeTruthy();
  });

  it("lists manual key-map entries and removes one", () => {
    const onChange = vi.fn<(s: JoinStep) => void>();
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
    expect(onChange.mock.calls[0]?.[0].matching.manualMap).toBeUndefined();
  });
});

describe("PreviewPane diagnostics", () => {
  const diagnostics = stepDiagnosticsOf(
    {
      steps: [
        {
          index: 0,
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
    0,
  );

  function pane(onAddToKeyMap: (from: string, to: string) => void, canMap = true) {
    return createElement(PreviewPane, {
      blockedReason: undefined,
      canMap,
      diagnostics,
      error: undefined,
      isLoading: false,
      mapDisabledReason: "Select a join step.",
      onAddToKeyMap,
      rows: [{ d: { name: "Kansas", deployments: 14 } }],
      title: "Step 1: Join",
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
    expect(button.getAttribute("title")).toBe("Select a join step.");
  });

  it("explains why there is no preview instead of staying blank", () => {
    render(
      createElement(PreviewPane, {
        blockedReason: "Step 1: Pick the key fields on both sides.",
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
