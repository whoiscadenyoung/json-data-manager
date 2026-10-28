// @vitest-environment jsdom
import type { TileArchiveBuildState } from "@caden/maps/build-scheduler";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TileArchiveBuildFailure } from "../lib/tile-archive";

// The real manager spawns a worker and imports the Convex API; the chip only
// reads two hooks and calls one trigger, so those are stubbed per test.
const store = vi.hoisted(() => ({
  ensure: vi.fn<(schemaId: string) => void>(),
  failure: undefined as TileArchiveBuildFailure | undefined,
  state: "idle" as TileArchiveBuildState,
}));

vi.mock("../lib/tile-archive", () => ({
  ensureMapTileArchive: store.ensure,
  useMapTileArchiveBuildFailure: () => store.failure,
  useMapTileArchiveBuildState: () => store.state,
}));

import { TileBuildStatus } from "./tile-build-status";

afterEach(() => {
  cleanup();
  store.ensure.mockReset();
  store.failure = undefined;
  store.state = "idle";
});

describe("TileBuildStatus failure state (#184)", () => {
  it("keeps a failed build visible after the error state reverts to idle", () => {
    store.failure = {
      failures: 2,
      message: "listGeometries timed out",
      retryAt: Date.UTC(2026, 9, 28, 15, 30),
    };
    render(<TileBuildStatus schemaId="schema-1" />);
    expect(screen.getByText("Map tiles failed to build")).toBeTruthy();
    expect(screen.getByText("listGeometries timed out")).toBeTruthy();
    expect(screen.getByText(/Retrying automatically at/)).toBeTruthy();
  });

  it("the Retry button starts a build now", () => {
    store.failure = { failures: 1, message: "boom", retryAt: undefined };
    render(<TileBuildStatus schemaId="schema-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(store.ensure).toHaveBeenCalledWith("schema-1");
  });

  it("a running retry shows the progress badge instead", () => {
    store.failure = { failures: 1, message: "boom", retryAt: undefined };
    store.state = "fetching";
    render(<TileBuildStatus schemaId="schema-1" />);
    expect(screen.queryByText("Map tiles failed to build")).toBeNull();
    expect(screen.getByText("Fetching features…")).toBeTruthy();
  });

  it("renders nothing while idle with no failure", () => {
    const { container } = render(<TileBuildStatus schemaId="schema-1" />);
    expect(container.childElementCount).toBe(0);
  });
});
