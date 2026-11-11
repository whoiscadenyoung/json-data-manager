// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LINEAGE_FIXTURE, STATES_ENRICHED } from "../lib/fixtures";
import type { GraphNode, StepSelection } from "../lib/graph-types";
import { buildLineageGraph } from "../lib/lineage-graph";
import { LineageGraphView } from "./lineage-graph-view";
import { ViewStepGraph } from "./view-step-graph";

beforeAll(() => {
  // React Flow measures nodes with these; jsdom has neither.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
    },
  );
});

afterEach(cleanup);

function withQueries(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

describe("LineageGraphView", () => {
  it("renders every node of the fixture project and the legend", async () => {
    const onOpen = vi.fn<(node: GraphNode) => void>();
    render(
      withQueries(<LineageGraphView graph={buildLineageGraph(LINEAGE_FIXTURE)} onOpen={onOpen} />),
    );

    expect(await screen.findByText("States enriched")).toBeTruthy();
    for (const label of [
      "States",
      "Deployments",
      "Overview map",
      "States layer",
      "State explorer",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByLabelText("Legend")).toBeTruthy();

    fireEvent.click(screen.getByText("Overview map"));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "map-1", kind: "map" }),
    );
  });

  it("shows an empty state when there is nothing to graph", () => {
    render(withQueries(<LineageGraphView graph={{ edges: [], nodes: [] }} />));
    expect(screen.getByText("Nothing to show yet")).toBeTruthy();
  });
});

describe("ViewStepGraph", () => {
  it("renders inputs, steps and output, and reports step clicks", async () => {
    const onSelectStep = vi.fn<(selection: StepSelection) => void>();
    render(
      withQueries(
        <ViewStepGraph
          definition={STATES_ENRICHED}
          onSelectStep={onSelectStep}
          selectedStep={{ index: 1 }}
        />,
      ),
    );

    expect(await screen.findByText("Output")).toBeTruthy();
    expect(screen.getByText("Left join links")).toBeTruthy();
    expect(screen.getByText("deploymentAgencies")).toBeTruthy();

    fireEvent.click(screen.getByText("Left join deployments"));
    expect(onSelectStep).toHaveBeenCalledWith({ index: 0 });
    fireEvent.click(screen.getByText("Left join deploymentAgencies"));
    expect(onSelectStep).toHaveBeenCalledWith({ index: 0, sub: 0 });
  });
});
