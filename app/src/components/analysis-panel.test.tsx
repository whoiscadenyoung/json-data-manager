// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisPanel } from "./analysis-panel";

/**
 * The analysis editor's run lifecycle (#133 item 8): a run's result must
 * never land after the editor moved on — here pinned through the unmount
 * half of the run-id guard (a superseding Run cannot start while the button
 * is disabled, so unmount is the reachable late-settlement path). The
 * worker, the resolver and the publish orchestrator are mocked at module
 * boundaries; `applySql` is not under test here.
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
  let latest:
    | {
        reject: (error: Error) => void;
        resolve: (value: MockRunResult) => void;
      }
    | undefined;
  return {
    nextRun: () => {
      if (latest === undefined) {
        throw new Error("no deferred run was armed");
      }
      return latest;
    },
    runAnalysis: vi.fn<() => Promise<MockRunResult>>(
      async () =>
        new Promise((resolve, reject) => {
          latest = { reject, resolve };
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
  vi.clearAllMocks();
});

async function openEditorAndRun() {
  render(<AnalysisPanel columns={["a"]} datasetTitle="Dataset" schemaId="schema-1" />);
  fireEvent.click(screen.getByRole("button", { name: /new analysis/i }));
  const sqlField = await screen.findByLabelText("SQL");
  fireEvent.change(sqlField, { target: { value: "SELECT 1 AS n" } });
  fireEvent.click(screen.getByRole("button", { name: /run query/i }));
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
    mocks.nextRun().resolve(RESULT);
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
    mocks.nextRun().resolve({ ...RESULT, rows: [{ n: "late" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("reports a rejected run through the error toast, once", async () => {
    await openEditorAndRun();
    await waitFor(() => {
      expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    });
    mocks.nextRun().reject(new Error("The analysis timed out after 180s."));
    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    });
    const firstCall = vi.mocked(toast.error).mock.calls[0];
    expect(firstCall === undefined ? undefined : firstCall[0]).toBe(
      "The analysis timed out after 180s.",
    );
  });
});
