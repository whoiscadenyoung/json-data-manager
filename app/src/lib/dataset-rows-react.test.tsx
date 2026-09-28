// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SchemaEntriesLoader,
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SPEC_ROW_ID = "spec-row-1";
const LOOKUP_ID = "lookup-1";

/** The hook's view, as one committed render reported it (undefined before the first effect flushed). */
type ExecutorView = ReturnType<typeof useEnrichedDatasetEntryRow> | undefined;

function viewOf(reads: Array<ExecutorView>): NonNullable<ExecutorView> {
  const last = reads[reads.length - 1];
  if (last === undefined) {
    throw new Error("the executor never committed a render");
  }
  return last;
}

function dataOf(reads: Array<ExecutorView>): unknown {
  const entry = viewOf(reads).entry;
  return entry === null || entry === undefined ? undefined : entry.data;
}

function entryRow(id: string, schemaId: string, data: unknown) {
  return { _creationTime: 0, _id: id, data, schemaId };
}

/** A saved, read-time-healthy spec shortlist entry (the `listBySource` projection). */
function readySummary(specRowId: string) {
  return {
    _creationTime: 0,
    _id: specRowId,
    createdBy: "user-1",
    health: "ready",
    sourceDatasetId: "schema-1",
    status: "saved",
    title: "Enriched sites",
  };
}

/** A full registry row (`derivedDatasets.get`) whose one lookup op names `lookupDatasetId`. */
function specDoc(specRowId: string, lookupDatasetId: string) {
  return {
    _creationTime: 0,
    _id: specRowId,
    dependsOn: ["schema-1", lookupDatasetId],
    sourceDatasetId: "schema-1",
    spec: {
      sourceDatasetId: "schema-1",
      operations: [
        {
          kind: "lookup",
          baseKey: "grantId",
          lookupDatasetId,
          lookupKey: "id",
          fields: ["status"],
        },
      ],
    },
    status: "saved",
    title: "Enriched sites",
  };
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

/** Routes the hook's two `useQueries` batches by the get's id: spec docs vs side registry-checks. */
function stubQueriesBatches(specRowId: string, lookupId: string, sideAnswer: unknown) {
  mocks.useQueries.mockImplementation((options) => {
    const first = options.queries[0];
    if (first === undefined) {
      return [];
    }
    if (first.args.id === specRowId) {
      return [{ data: specDoc(specRowId, lookupId) }];
    }
    return [{ data: sideAnswer }];
  });
}

const SKIP_STATE = { results: [], status: "Exhausted" };

/**
 * Stubs the lookup-side fan-out's pager with a REFERENCE-STABLE state — the
 * real `usePaginatedQuery` serves stable arrays between changes, and the
 * fan-out's bail-out dedupe (and therefore render termination) relies on it.
 */
function stubAllPaginated(state: { results: unknown[]; status: string }) {
  mocks.useAllPaginated.mockImplementation((_reference: unknown, args: unknown) =>
    args === "skip" ? SKIP_STATE : state,
  );
}

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

/** The last reported view, or undefined before the first effect flushed. */
function lastReported(onRender: { mock: { lastCall?: [ExecutorView] } }): ExecutorView {
  const last = onRender.mock.lastCall;
  return last === undefined ? undefined : last[0];
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

  it("enriches the clicked entry with the saved ready spec's namespaced fields", async () => {
    stubQueryByArgs(entryRow("entry-1", "schema-1", { grantId: "G1" }), [
      readySummary(SPEC_ROW_ID),
    ]);
    stubQueriesBatches(SPEC_ROW_ID, LOOKUP_ID, null); // side check: lookup-1 is a component dataset
    stubAllPaginated({
      results: [entryRow("l1", LOOKUP_ID, { id: "G1", status: "open" })],
      status: "Exhausted",
    });

    const { onRender } = renderExecutor({ entryId: "entry-1", schemaId: "schema-1" });
    await waitFor(() => {
      expect(onRender.mock.calls.length).toBeGreaterThan(0);
    });

    expect(dataOf(onRender.mock.calls.map((call) => call[0]))).toStrictEqual({
      grantId: "G1",
      "lookup-1.status": "open",
    });
    expect(mocks.useAllPaginated.mock.calls.some((call) => call[1] !== "skip")).toBe(true);
    expect(viewOf(onRender.mock.calls.map((call) => call[0])).loaders).toHaveLength(1);
  });

  it("drops every join subscription when the selection closes", async () => {
    stubQueryByArgs(entryRow("entry-1", "schema-1", { grantId: "G1" }), [
      readySummary(SPEC_ROW_ID),
    ]);
    stubQueriesBatches(SPEC_ROW_ID, LOOKUP_ID, null);
    stubAllPaginated({
      results: [entryRow("l1", LOOKUP_ID, { id: "G1", status: "open" })],
      status: "Exhausted",
    });

    const { onRender, rerender } = renderExecutor({
      entryId: "entry-1",
      schemaId: "schema-1",
    });
    await waitFor(() => {
      const view = lastReported(onRender);
      expect(view !== undefined && view.joinedPending).toBe(false);
    });
    expect(mocks.useAllPaginated.mock.calls.some((call) => call[1] !== "skip")).toBe(true);

    // Only calls made AFTER the close count: the mock's history keeps the
    // open-popup reads, and the assertion is that closing adds no new ones.
    const queryCalls = mocks.useQuery.mock.calls.length,
      paginatedCalls = mocks.useAllPaginated.mock.calls.length,
      queriesCalls = mocks.useQueries.mock.calls.length;
    rerender(undefined);

    expect(
      mocks.useQuery.mock.calls.slice(queryCalls).every((call) => call[1] === "skip"),
    ).toBe(true);
    expect(
      mocks.useAllPaginated.mock.calls.slice(paginatedCalls).every((call) => call[1] === "skip"),
    ).toBe(true);
    expect(
      mocks.useQueries.mock.calls
        .slice(queriesCalls)
        .every((call) => call[0].queries.length === 0),
    ).toBe(true);
  });

  it("settles base-only when a lookup side is a registry row — never all-null 'ready' answers", async () => {
    stubQueryByArgs(entryRow("entry-1", "schema-1", { grantId: "G1" }), [
      readySummary(SPEC_ROW_ID),
    ]);
    // The side check answers with a REGISTRY row for registry-1: it has no
    // entry rows to stream (compute-on-read), so the executor must not
    // stream it and must not present the spec's answer as all-null fields.
    stubQueriesBatches(SPEC_ROW_ID, "registry-1", specDoc("registry-1", "whatever"));
    stubAllPaginated({ results: [], status: "Exhausted" });

    const { onRender } = renderExecutor({ entryId: "entry-1", schemaId: "schema-1" });
    await waitFor(() => {
      const view = lastReported(onRender);
      expect(view !== undefined && view.joinedPending).toBe(false);
    });

    expect(mocks.useAllPaginated.mock.calls.every((call) => call[1] === "skip")).toBe(true);
    expect(dataOf(onRender.mock.calls.map((call) => call[0]))).toStrictEqual({ grantId: "G1" });
  });

  it("stays pending while a component lookup side's rows are still streaming", () => {
    stubQueryByArgs(entryRow("entry-1", "schema-1", { grantId: "G1" }), [
      readySummary(SPEC_ROW_ID),
    ]);
    stubQueriesBatches(SPEC_ROW_ID, LOOKUP_ID, null);
    stubAllPaginated({ results: [], status: "CanLoadMore" });

    const { onRender } = renderExecutor({ entryId: "entry-1", schemaId: "schema-1" });

    const view = viewOf(onRender.mock.calls.map((call) => call[0]));
    expect(view.joinedPending).toBe(true);
    // Base fields render immediately while the side streams.
    expect(dataOf(onRender.mock.calls.map((call) => call[0]))).toStrictEqual({ grantId: "G1" });
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

    const { rerender } = render(
      <SchemaEntriesLoader schemaId="s1" enabled onLoaded={onLoaded} />,
    );
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
