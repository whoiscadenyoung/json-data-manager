// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setPlacementVisibility: vi.fn<(args: unknown) => Promise<number>>(),
}));

vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: (props: { children?: React.ReactNode }) => createElement("a", {}, props.children),
  };
});
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));
vi.mock("#/lib/store/layers", () => ({}));
vi.mock("#/lib/store/maps", () => ({ setPlacementVisibility: mocks.setPlacementVisibility }));

import type { ArtifactRefRow, LayerChildRow, LayerRow, LayerVersionRow } from "#/lib/store/layers";
import type { MapPlacementRow } from "#/lib/store/maps";

import { LayerOutline, type OutlineProps } from "./layer-outline";

function layer(id: string, name: string, datasetMemberId: string | null): LayerRow {
  return {
    createdAt: "",
    createdBy: "u1",
    datasetMemberId,
    filter: null,
    id,
    kind: datasetMemberId === null ? "group" : "data",
    labels: null,
    lifecycle: id === "l1" ? "published" : "draft",
    name,
    needsAttention: null,
    opacity: null,
    popup: null,
    projectId: "p1",
    style: {},
    updatedAt: "",
    visibility: "members",
    visible: true,
  };
}

const PLACEMENTS: MapPlacementRow[] = [
    { id: "pl-1", layerMemberId: "m-l1", mapId: "map", order: 0, visible: true },
    { id: "pl-2", layerMemberId: "m-g", mapId: "map", order: 1, visible: true },
    { id: "pl-3", layerMemberId: "m-v", mapId: "map", order: 2, visible: false },
  ],
  MEMBERSHIPS = new Map<string, ArtifactRefRow>([
    ["m-l1", { artifactId: "l1", artifactKind: "layer", id: "m-l1", role: "owned" }],
    ["m-g", { artifactId: "g1", artifactKind: "layer", id: "m-g", role: "owned" }],
    ["m-v", { artifactId: "v1", artifactKind: "layer", id: "m-v", role: "linked" }],
    ["m-d1", { artifactId: "d-states", artifactKind: "dataset", id: "m-d1", role: "owned" }],
    ["m-d2", { artifactId: "d-roads", artifactKind: "dataset", id: "m-d2", role: "owned" }],
  ]),
  LAYERS = new Map<string, LayerRow>([
    ["l1", layer("l1", "States", "m-d1")],
    ["g1", layer("g1", "Transport", null)],
    ["l2", layer("l2", "Roads", "m-d2")],
  ]),
  CHILDREN = new Map<string, LayerChildRow[]>([
    ["g1", [{ childKind: "owned", childLayerId: "l2", groupId: "g1", id: "c-1", order: 0 }]],
  ]),
  // Only the label is read by the list.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  VERSIONS = new Map([["v1", { id: "v1", versionLabel: "v2" } as LayerVersionRow]]);

/** The draggable row that holds a layer's name. */
function rowOf(name: string): HTMLElement {
  const row = screen.getByRole("button", { name }).closest("[draggable]");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

function renderOutline(overrides: Partial<OutlineProps> = {}) {
  const props: OutlineProps = {
    childrenLists: CHILDREN,
    collapsedGroups: new Set(),
    colorOf: () => "#3b82f6",
    layersById: LAYERS,
    memberships: MEMBERSHIPS,
    onAddChild: vi.fn<(id: string) => void>(),
    onGroupRelated: undefined,
    onMove: vi.fn<(placementId: string, toIndex: number) => void>(),
    onPopupFields: vi.fn<(id: string) => void>(),
    onRemove: vi.fn<() => void>(),
    onSelect: vi.fn<() => void>(),
    placements: PLACEMENTS,
    projectId: "p1",
    run: async (job) => {
      await job();
      return true;
    },
    selectedRowId: undefined,
    toggleCollapsed: vi.fn<(key: string) => void>(),
    versionsById: VERSIONS,
    ...overrides,
  };
  render(createElement(LayerOutline, props));
  return props;
}

beforeEach(() => {
  mocks.setPlacementVisibility.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  cleanup();
});

describe("LayerOutline", () => {
  it("lists every layer in draw order, with a group's layers under it", () => {
    renderOutline();
    expect(screen.getByText("Layers (3)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "States" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Transport" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Roads" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Linked layer · v2" })).toBeTruthy();
    expect(screen.getByLabelText("Published")).toBeTruthy();
  });

  it("selects a layer when its name is clicked, saying what kind it is", () => {
    const props = renderOutline();
    fireEvent.click(screen.getByRole("button", { name: "States" }));
    expect(props.onSelect).toHaveBeenCalledWith({
      kind: "data",
      layerId: "l1",
      name: "States",
      rowId: "pl-1",
      versionId: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "Linked layer · v2" }));
    expect(props.onSelect).toHaveBeenLastCalledWith({
      kind: "linked",
      layerId: undefined,
      name: "Linked layer · v2",
      rowId: "pl-3",
      versionId: "v1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Roads" }));
    expect(props.onSelect).toHaveBeenLastCalledWith({
      kind: "data",
      layerId: "l2",
      name: "Roads",
      rowId: "c-1",
      versionId: undefined,
    });
  });

  it("hides a layer from its eye without selecting it", async () => {
    const props = renderOutline();
    fireEvent.click(screen.getByRole("button", { name: 'Hide "States"' }));
    await waitFor(() => {
      expect(mocks.setPlacementVisibility).toHaveBeenCalledWith({
        placementId: "pl-1",
        visible: false,
      });
    });
    expect(props.onSelect).not.toHaveBeenCalled();
    // The hidden linked layer offers to show itself again.
    expect(screen.getByRole("button", { name: 'Show "Linked layer · v2"' })).toBeTruthy();
  });

  it("moves a layer to the row it is dropped on", () => {
    const props = renderOutline(),
      dataTransfer = { effectAllowed: "", setData: vi.fn<() => void>() };
    fireEvent.dragStart(rowOf("Linked layer · v2"), { dataTransfer });
    fireEvent.dragOver(rowOf("States"), { dataTransfer });
    expect(rowOf("States").getAttribute("data-drop")).toBe("true");
    fireEvent.drop(rowOf("States"), { dataTransfer });
    expect(props.onMove).toHaveBeenCalledWith("pl-3", 0);
  });

  it("collapses a group and offers to group related layers when there are some", () => {
    const onGroupRelated = vi.fn<() => void>(),
      props = renderOutline({ collapsedGroups: new Set(["pl-2"]), onGroupRelated });
    expect(screen.queryByRole("button", { name: "Roads" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: 'Expand "Transport"' }));
    expect(props.toggleCollapsed).toHaveBeenCalledWith("pl-2");
    fireEvent.click(screen.getByRole("button", { name: "Group related layers" }));
    expect(onGroupRelated).toHaveBeenCalledTimes(1);
  });
});
