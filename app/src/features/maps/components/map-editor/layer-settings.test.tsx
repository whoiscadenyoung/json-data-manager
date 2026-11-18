// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
// The settings panel only reads the styling hook's result; the module is not the subject.
vi.mock("#/features/layer-styles", () => ({}));

import type { UseLayerStylesResult } from "#/features/layer-styles";
import type { LayerRow, LayerVersionRow } from "#/lib/store/layers";

import { LayerSettings } from "./layer-settings";

const LAYER: LayerRow = {
  createdAt: "",
  createdBy: "u1",
  datasetMemberId: "m-d1",
  filter: null,
  id: "l1",
  kind: "data",
  labels: null,
  lifecycle: "draft",
  name: "States",
  needsAttention: "The field “pop” was removed.",
  opacity: null,
  popup: null,
  projectId: "p1",
  style: {},
  updatedAt: "",
  visibility: "members",
  visible: true,
};

function styling(overrides: Partial<UseLayerStylesResult> = {}): UseLayerStylesResult {
  return {
    colorBySchema: new Map(),
    datasetActions: () => null,
    edit: vi.fn<UseLayerStylesResult["edit"]>(),
    editingId: undefined,
    extension: { legendFor: () => undefined, renderLayer: () => undefined },
    isStyled: () => false,
    loaders: null,
    panel: createElement("div", {}, "Style controls"),
    reset: vi.fn<UseLayerStylesResult["reset"]>(),
    ...overrides,
  };
}

type Props = ComponentProps<typeof LayerSettings>;

function renderSettings(overrides: Partial<Props> = {}) {
  const props: Props = {
    childCount: 0,
    dataset: { id: "d-states", title: "States (2024)" },
    layer: LAYER,
    onAddChild: vi.fn<(id: string) => void>(),
    onClone: vi.fn<(id: string) => void>(),
    onClose: vi.fn<() => void>(),
    onPopupFields: vi.fn<(id: string) => void>(),
    projectId: "p1",
    relationNotes: ["Linked to Deployments via id ↔ stateId"],
    selection: { kind: "data", layerId: "l1", name: "States", rowId: "pl-1", versionId: undefined },
    styling: styling(),
    version: undefined,
    ...overrides,
  };
  render(createElement(LayerSettings, props));
  return props;
}

afterEach(() => {
  cleanup();
});

describe("LayerSettings", () => {
  it("shows a data layer's dataset, relations and what needs attention", () => {
    renderSettings();
    expect(screen.getByRole("heading", { name: "States" })).toBeTruthy();
    expect(screen.getByText("States (2024)")).toBeTruthy();
    expect(screen.getByText("Linked to Deployments via id ↔ stateId")).toBeTruthy();
    expect(screen.getByText("The field “pop” was removed.")).toBeTruthy();
  });

  it("opens the style controls for the layer's dataset", () => {
    const props = renderSettings();
    expect(screen.queryByText("Style controls")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit style" }));
    expect(props.styling.edit).toHaveBeenCalledWith({ renderId: "d-states", title: "States" });
  });

  it("shows the style controls in place while the layer is being styled", () => {
    renderSettings({ styling: styling({ editingId: "d-states" }) });
    expect(screen.getByText("Style controls")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit style" })).toBeNull();
  });

  it("offers to reset a layer that has its own style", () => {
    const props = renderSettings({ styling: styling({ isStyled: () => true }) });
    fireEvent.click(screen.getByRole("button", { name: "Reset style" }));
    expect(props.styling.reset).toHaveBeenCalledWith("d-states");
  });

  it("opens the popup fields and closes from the header", () => {
    const props = renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Popup fields…" }));
    expect(props.onPopupFields).toHaveBeenCalledWith("l1");
    fireEvent.click(screen.getByRole("button", { name: "Close layer settings" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("says what a group holds and adds to it", () => {
    const props = renderSettings({
      childCount: 2,
      dataset: undefined,
      layer: { ...LAYER, datasetMemberId: null, id: "g1", kind: "group", name: "Transport" },
      selection: {
        kind: "group",
        layerId: "g1",
        name: "Transport",
        rowId: "pl-2",
        versionId: undefined,
      },
    });
    expect(screen.getByText(/Holds 2 layers/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add layer to group" }));
    expect(props.onAddChild).toHaveBeenCalledWith("g1");
  });

  it("explains a linked layer and copies it into an editable one", () => {
    const props = renderSettings({
      dataset: undefined,
      layer: undefined,
      selection: {
        kind: "linked",
        layerId: undefined,
        name: "Linked layer · v2",
        rowId: "pl-3",
        versionId: "v1",
      },
      // Only the id and label are read.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      version: { id: "v1", versionLabel: "v2" } as LayerVersionRow,
    });
    expect(screen.getByText(/stays as it was published/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make an editable copy" }));
    expect(props.onClone).toHaveBeenCalledWith("v1");
  });
});
