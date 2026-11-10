// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SchemaEntriesLoader,
  SchemaGeometriesLoader,
  useEnrichedDatasetEntryRow,
} from "./dataset-rows-react";
import type { FeatureSelection } from "./dataset-rows-react";

// The reactive seam's data layer, mocked at module boundaries: the point
// reads and the spec shortlist ride convex/react's `useQuery`, the two
// spec/registry-check batches ride TanStack's `useQueries`, the lookup-side
// fan-out rides `@caden/json-cms/react`'s `useAllPaginated`, and
// `convexQuery` is stubbed as a plain arg carrier the mocks can read. The
// fold itself (`applyEntryRowSpec` over the seam's own reader) is NOT
// mocked — these tests prove the composition, not just the parts.
const mocks = vi.hoisted(() => ({
  useQuery: vi.fn<(reference: unknown, args: unknown) => unknown>(),
  useQueries: vi.fn<(options: { queries: Array<{ args: { id?: string } }> }) => unknown>(),
  useAllPaginated: vi.fn<(reference: unknown, args: unknown) => unknown>(),
}));

vi.mock("convex/react", () => ({ useQuery: mocks.useQuery }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueries: mocks.useQueries,
}));
vi.mock("@caden/json-cms/react", () => ({ useAllPaginated: mocks.useAllPaginated }));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (reference: unknown, args: unknown) => ({ reference, args }),
}));
// The seam's imperative layer derives its client from `#/env` at import
// time; the reactive tests stub every client boundary, so the env module
// never has to load.
vi.mock("#/env", () => ({ env: { VITE_CONVEX_URL: "http://127.0.0.1:3212" } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The hook's view, as one committed render reported it (undefined before the first effect flushed). */
type ExecutorView = ReturnType<typeof useEnrichedDatasetEntryRow> | undefined;

function viewOf(reads: Array<ExecutorView>): NonNullable<ExecutorView> {
  const last = reads[reads.length - 1];
  if (last === undefined) {
    throw new Error("the executor never committed a render");
  }
  return last;
}

function entryRow(id: string, schemaId: string, data: unknown) {
  return { _creationTime: 0, _id: id, data, schemaId };
}

/** Routes the hook's `useQuery` calls by args shape: "skip" suspends, an entryId is the point read, a sourceDatasetId is the shortlist. */
function stubQueryByArgs(entry: unknown, summaries: unknown[]) {
  mocks.useQuery.mockImplementation((_reference: unknown, args: unknown) => {
    if (args === "skip") {
      return undefined;
    }
    const record = args as { entryId?: string; sourceDatasetId?: string };
    if (record.entryId !== undefined) {
      return entry;
    }
    return record.sourceDatasetId !== undefined ? summaries : undefined;
  });
}

const SKIP_STATE = { results: [], status: "Exhausted" };

/** The probe component: mounts the executor's loaders (they hold the join subscriptions) and reports each committed render upward. */
function ExecutorProbe({
  value,
  onRender,
}: {
  value: FeatureSelection | undefined;
  onRender: (view: ExecutorView) => void;
}) {
  const view = useEnrichedDatasetEntryRow(value);
  useEffect(() => {
    onRender(view);
  }, [onRender, view]);
  return <>{view.loaders}</>;
}

/**
 * Mounts the hook the way the popup does — `loaders` rendered, since they
 * are what holds the lookup-row subscriptions (a bare `renderHook` never
 * mounts them and the reports never arrive). Each committed render is
 * reported through `onRender` (an effect callback, not a render-phase
 * write).
 */
function renderExecutor(selection: FeatureSelection | undefined) {
  const onRender = vi.fn<(view: ExecutorView) => void>();
  const { rerender } = render(<ExecutorProbe value={selection} onRender={onRender} />);
  return {
    onRender,
    rerender: (next: FeatureSelection | undefined) => {
      rerender(<ExecutorProbe value={next} onRender={onRender} />);
    },
  };
}

describe("useEnrichedDatasetEntryRow", () => {
  it("subscribes to nothing without a selection — a map's first paint pays no join reads (#52/#97)", () => {
    stubQueryByArgs(undefined, []);
    mocks.useQueries.mockReturnValue([]);
    mocks.useAllPaginated.mockReturnValue(SKIP_STATE);

    const { onRender, rerender } = renderExecutor(undefined);
    rerender(undefined);

    const view = viewOf(onRender.mock.calls.map((call) => call[0]));
    expect(view.entry).toBeUndefined();
    expect(view.joinedPending).toBe(false);
    const queryArgs = mocks.useQuery.mock.calls.map((call) => call[1]);
    expect(queryArgs.length).toBeGreaterThan(0);
    expect(queryArgs.every((args) => args === "skip")).toBe(true);
    expect(mocks.useAllPaginated.mock.calls.every((call) => call[1] === "skip")).toBe(true);
    expect(mocks.useQueries.mock.calls.every((call) => call[0].queries.length === 0)).toBe(true);
  });
});

describe("SchemaEntriesLoader", () => {
  it("reports rows and completion on a full pass, un-latches when disabled, and re-completes on a fresh pass", () => {
    const onLoaded = vi.fn<(schemaId: string, report: unknown) => void>();
    const firstRows = [entryRow("l1", "s1", { id: "G1" })];
    let paginated: { results: unknown[]; status: string } = {
      results: firstRows,
      status: "Exhausted",
    };
    mocks.useAllPaginated.mockImplementation((_reference: unknown, args: unknown) =>
      args === "skip" ? SKIP_STATE : paginated,
    );

    const { rerender } = render(<SchemaEntriesLoader schemaId="s1" enabled onLoaded={onLoaded} />);
    expect(onLoaded).toHaveBeenCalledWith("s1", { complete: true, rows: firstRows });

    // Disabled: the report drops to undefined AND the completion latch
    // resets — a stale `complete: true` must not pair with an empty
    // result set on reopen.
    rerender(<SchemaEntriesLoader schemaId="s1" enabled={false} onLoaded={onLoaded} />);
    expect(onLoaded).toHaveBeenLastCalledWith("s1", undefined);

    paginated = { results: [], status: "CanLoadMore" };
    rerender(<SchemaEntriesLoader schemaId="s1" enabled onLoaded={onLoaded} />);
    expect(onLoaded).toHaveBeenLastCalledWith("s1", { complete: false, rows: [] });

    const secondRows = [entryRow("l2", "s1", { id: "G2" })];
    paginated = { results: secondRows, status: "Exhausted" };
    rerender(<SchemaEntriesLoader schemaId="s1" enabled onLoaded={onLoaded} />);
    expect(onLoaded).toHaveBeenLastCalledWith("s1", { complete: true, rows: secondRows });
  });
});

describe("SchemaGeometriesLoader (#186)", () => {
  it("requests 500-row pages", () => {
    mocks.useAllPaginated.mockReturnValue({ results: [], status: "CanLoadMore" });
    render(
      <SchemaGeometriesLoader
        schemaId="s1"
        onLoaded={vi.fn<(schemaId: string, report: unknown) => void>()}
      />,
    );
    expect(mocks.useAllPaginated).toHaveBeenCalledWith(
      expect.anything(),
      { schemaId: "s1" },
      {
        pageSize: 500,
      },
    );
  });

  it("throttles partial reports to the latest rows and reports completion immediately", () => {
    vi.useFakeTimers();
    try {
      const onLoaded = vi.fn<(schemaId: string, report: unknown) => void>(),
        page1 = [{ _id: "g1" }],
        page2 = [{ _id: "g1" }, { _id: "g2" }],
        page3 = [{ _id: "g1" }, { _id: "g2" }, { _id: "g3" }];
      let paginated: { results: unknown[]; status: string } = {
        results: page1,
        status: "CanLoadMore",
      };
      mocks.useAllPaginated.mockImplementation(() => paginated);
      const { rerender } = render(<SchemaGeometriesLoader schemaId="s1" onLoaded={onLoaded} />);
      // First report is immediate.
      expect(onLoaded).toHaveBeenCalledTimes(1);

      // Pages landing inside the window are held back, then flushed once
      // with the LATEST rows.
      paginated = { results: page2, status: "CanLoadMore" };
      rerender(<SchemaGeometriesLoader schemaId="s1" onLoaded={onLoaded} />);
      paginated = { results: page3, status: "CanLoadMore" };
      rerender(<SchemaGeometriesLoader schemaId="s1" onLoaded={onLoaded} />);
      expect(onLoaded).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(250);
      expect(onLoaded).toHaveBeenCalledTimes(2);
      expect(onLoaded).toHaveBeenLastCalledWith("s1", { complete: false, rows: page3 });

      // Completion bypasses the throttle.
      paginated = { results: page3, status: "Exhausted" };
      rerender(<SchemaGeometriesLoader schemaId="s1" onLoaded={onLoaded} />);
      expect(onLoaded).toHaveBeenCalledTimes(3);
      expect(onLoaded).toHaveBeenLastCalledWith("s1", { complete: true, rows: page3 });
    } finally {
      vi.useRealTimers();
    }
  });
});
