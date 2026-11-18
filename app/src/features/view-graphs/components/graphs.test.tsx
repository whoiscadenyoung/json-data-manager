// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LINEAGE_FIXTURE, STATES_ENRICHED } from "../lib/fixtures";
import type { GraphNode } from "../lib/graph-types";
import { buildLineageGraph } from "../lib/lineage-graph";
import { LineageGraphView } from "./lineage-graph-view";
import { ViewNodeGraph } from "./view-node-graph";

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

describe("ViewNodeGraph", () => {
  it("renders sources, nodes and output, and reports node clicks", async () => {
    const onSelectNode = vi.fn<(id: string) => void>();
    render(
      withQueries(
        <ViewNodeGraph
          definition={STATES_ENRICHED}
          onSelectNode={onSelectNode}
          selectedNode="enriched"
        />,
      ),
    );

    expect(await screen.findByText("Output")).toBeTruthy();
    expect(screen.getByText("Left join links")).toBeTruthy();
    expect(screen.getByText("Agencies per deployment")).toBeTruthy();

    fireEvent.click(screen.getByText("Left join links"));
    expect(onSelectNode).toHaveBeenCalledWith("enriched");
    fireEvent.click(screen.getByText("Agencies per deployment"));
    expect(onSelectNode).toHaveBeenCalledWith("agency_counts");
  });
});
