// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisPanel } from "./analysis-panel";

/**
 * The analysis editor's run lifecycle (#133 item 8): a run's result must
 * never land after the editor moved on. Both halves of the run-id guard are
 * pinned differentially — a superseding run (the issue's actual defect: an
 * earlier run's rows overwriting a newer run's; the second Run is dispatched
 * at the handler seam, since the UI disables the button while a run is in
 * flight) and a settlement after unmount. The worker, the resolver and the
 * publish orchestrator are mocked at module boundaries; `applySql` is not
 * under test here.
 */
interface MockRunResult {
  diagnostics: {
    coercedNulls: number;
    error?: string;
    resultRows: number;
    tables: string[];
    totalSourceRows: number;
    truncated: boolean;
  };
  rows: Array<Record<string, unknown>>;
}

const mocks = vi.hoisted(() => {
  const pending: Array<{
    reject: (error: Error) => void;
    resolve: (value: MockRunResult) => void;
  }> = [];
  return {
    // The deferred runs in call order — index 0 is the oldest in-flight run.
    run(index: number): {
      reject: (error: Error) => void;
      resolve: (value: MockRunResult) => void;
    } {
      const deferred = pending[index];
      if (deferred === undefined) {
        throw new Error(`no deferred run was armed at index ${index}`);
      }
      return deferred;
    },
    resetRuns: (): void => {
      pending.length = 0;
    },
    runAnalysis: vi.fn<() => Promise<MockRunResult>>(
      async () =>
        new Promise((resolve, reject) => {
          pending.push({ reject, resolve });
        }),
    ),
  };
});

vi.mock("#/lib/analysis", () => ({
  runAnalysis: mocks.runAnalysis,
}));
vi.mock("#/lib/dataset-rows", () => ({
  sharedClient: vi.fn<
    () => {
      query: () => Promise<Array<{ datasetId: string; resolvedSchemaId: string; status: string }>>;
    }
  >(() => ({
    query: async () => [
      { datasetId: "schema-1", resolvedSchemaId: "resolved-1", status: "identity" },
    ],
  })),
}));
vi.mock("#/lib/publish", () => ({
  publishDataset: vi.fn<() => Promise<void>>(),
}));
vi.mock("convex/react", () => ({
  useMutation: vi.fn<() => () => Promise<string>>(() => async () => "row-id"),
}));
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQuery: vi.fn<() => { data: unknown[] }>(() => ({ data: [] })),
}));
vi.mock("@convex-dev/react-query", () => ({
  convexQuery: (reference: unknown, args: unknown) => ({ reference, args }),
}));

import { toast } from "sonner";

afterEach(() => {
  cleanup();
  mocks.resetRuns();
  vi.clearAllMocks();
});

async function openEditorAndRun() {
  render(<AnalysisPanel columns={["a"]} datasetTitle="Dataset" schemaId="schema-1" />);
  fireEvent.click(screen.getByRole("button", { name: /new analysis/i }));
  const sqlField = await screen.findByLabelText("SQL");
  fireEvent.change(sqlField, { target: { value: "SELECT 1 AS n" } });
  fireEvent.click(screen.getByRole("button", { name: /run query/i }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Delivers a Run at the component's own handler while the button renders
 * disabled: the UI can't produce a superseding run (Run is disabled while a
 * run is in flight, React withholds synthetic events from disabled
 * controls, and Base UI's button wrapper gates its host onClick on the same
 * prop), but the run-id guard exists for exactly this reentrancy — an
 * earlier run must never overwrite a newer run's rows, however a second Run
 * is delivered. The raw handler sits on the nearest fiber above the host
 * button (Base UI's wrapper owns the host props), so the walk reads it
 * there.
 */
function runWhileDisabled(button: HTMLElement): void {
  // Object.entries (not key indexing): react's instance handles are not
  // HTMLElement properties the type system knows about.
  const hostPropsEntry = Object.entries(button).find(([key]) => key.startsWith("__reactProps$")),
    fiberEntry = Object.entries(button).find(([key]) => key.startsWith("__reactFiber$"));
  const hostProps: unknown = hostPropsEntry === undefined ? undefined : hostPropsEntry[1],
    fiber: unknown = fiberEntry === undefined ? undefined : fiberEntry[1];
  if (!isRecord(hostProps) || typeof hostProps.onClick !== "function" || !isRecord(fiber)) {
    throw new Error("the running button exposed no react handles");
  }
  for (let cursor: unknown = fiber.return; isRecord(cursor); cursor = cursor.return) {
    const props = cursor.memoizedProps;
    if (
      isRecord(props) &&
      typeof props.onClick === "function" &&
      props.onClick !== hostProps.onClick
    ) {
      props.onClick(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return;
    }
  }
  throw new Error("the running button exposed no raw onClick above the disabled gate");
}

const RESULT = {
  diagnostics: {
    coercedNulls: 0,
    resultRows: 1,
    tables: ["source"],
    totalSourceRows: 1,
    truncated: false,
  },
  rows: [{ n: 1 }],
};

describe("AnalysisPanel — the run lifecycle (#133 item 8)", () => {
  it("renders a finished run's rows", async () => {
    await openEditorAndRun();
    await waitFor(() => {
      expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    });
    mocks.run(0).resolve(RESULT);
    expect(await screen.findByText("1")).toBeDefined();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("drops a result that settles after the editor unmounted", async () => {
    await openEditorAndRun();
    await waitFor(() => {
      expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    });
    cleanup();
    // The late settlement: resolving after unmount must not throw, retry,
    // or surface anything — the run-id guard dropped it.
    mocks.run(0).resolve({ ...RESULT, rows: [{ n: "late" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("keeps a newer run's rows when an older run settles last", async () => {
    await openEditorAndRun();
    await waitFor(() => {
      expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    });
    // The superseding half of the guard (#133 item 8): a second Run while
    // the first is parked inside the worker call. Delivered at the handler
    // seam (see runWhileDisabled) — the guard exists for exactly this
    // reentrancy.
    await act(async () => {
      runWhileDisabled(screen.getByRole("button", { name: /running/i }));
    });
    await waitFor(() => {
      expect(mocks.runAnalysis).toHaveBeenCalledTimes(2);
    });
    mocks.run(1).resolve({ ...RESULT, rows: [{ n: "new" }] });
    expect(await screen.findByText("new")).toBeDefined();
    // The OLDER run settles last — unguarded code would let its rows
    // overwrite the newer run's in the preview.
    mocks.run(0).resolve({ ...RESULT, rows: [{ n: "old" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("old")).toBeNull();
    expect(screen.getByText("new")).toBeDefined();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("reports a rejected run through the error toast, once", async () => {
    await openEditorAndRun();
    await waitFor(() => {
      expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    });
    mocks.run(0).reject(new Error("The analysis timed out after 180s."));
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    const firstCall = vi.mocked(toast.error).mock.calls[0];
    expect(firstCall === undefined ? undefined : firstCall[0]).toBe(
      "The analysis timed out after 180s.",
    );
  });
});
