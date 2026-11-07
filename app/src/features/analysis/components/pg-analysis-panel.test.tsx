import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The panel's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

/**
 * The PG analysis run's dispatch contract (stage 5, #204): the run carries
 * `backend: "pg"` (the transitional origin split rides the request), the
 * source registers as `source` with the dataset's DECLARED column types
 * (the typed-structures invariant), and a finished run's rows render. The
 * worker manager and the store reads are mocked at module boundaries;
 * `applySql`/DuckDB are not under test here.
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
    run(index: number) {
      const deferred = pending[index];
      if (deferred === undefined) {
        throw new Error(`no deferred run was armed at index ${index}`);
      }
      return deferred;
    },
    resetRuns: (): void => {
      pending.length = 0;
    },
    runAnalysis: vi.fn<
      (request: {
        backend?: string;
        source?: { as?: string; columns?: unknown; schemaId?: string; title?: string };
      }) => Promise<MockRunResult>
    >(
      async () =>
        new Promise((resolve, reject) => {
          pending.push({ reject, resolve });
        }),
    ),
    useQuery: vi.fn<(options: { queryKey: unknown[] }) => unknown>(),
  };
});

vi.mock("../lib/analysis", () => ({
  runAnalysis: mocks.runAnalysis,
}));

vi.mock("#/lib/store/derived", () => ({
  getQueryOptions: (args: { id: string }) => ({ queryKey: ["pg:derived", "get", args] }),
  listBySourceQueryOptions: (args: { sourceDatasetId: string }) => ({
    queryKey: ["pg:derived", "listBySource", args],
  }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQuery: mocks.useQuery,
}));

vi.mock("#/features/catalog", () => ({
  PgDatasetPickerSheet: () => null,
}));

vi.mock("@/integrations/supabase/provider", () => ({
  useSession: () => ({ isLoading: false, session: { user: { id: "creator-1" } } }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

import { declaredColumnTypes } from "@caden/data-core/transform";

import type { DatasetRow } from "#/lib/store/datasets";

import { PgAnalysisPanel } from "./pg-analysis-panel";

/** A minimal PG dataset row (uuid id, declared structure with two columns). */
function datasetOf(): DatasetRow {
  return {
    bbox: null,
    createdAt: "2026-11-04T00:00:00+00:00",
    createdBy: "creator-1",
    description: null,
    editPolicy: "open",
    entryCount: 2,
    featureCount: 0,
    geometryType: null,
    groupId: null,
    id: "0f0e9d8c-7b6a-4958-8273-1a2b3c4d5e6f",
    isGeospatial: false,
    jsonSchema: {
      properties: { awards: { type: "number" }, state: { type: "string" } },
      title: "Awards",
    },
    lifecycle: "published",
    lineage: null,
    mapTileArchiveBytes: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileArchivePath: null,
    mapTileCacheVersion: 1,
    maxGeometryRowBytes: null,
    properties: ["awards", "state"],
    visibility: "signed-in",
    simplifyGeometry: false,
    source: null,
    sourceFileName: null,
    sourceFilePath: null,
    sourceFileSize: null,
    title: "Awards",
    updatedAt: "2026-11-04T00:00:00+00:00",
  };
}

afterEach(() => {
  cleanup();
  mocks.resetRuns();
  vi.clearAllMocks();
});

/** The registry queries answer empty — the panel opens on the list; the run path needs no registry rows. */
function stubEmptyQueries() {
  mocks.useQuery.mockImplementation(() => ({ data: [] }));
}

async function openEditorAndRun() {
  stubEmptyQueries();
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(PgAnalysisPanel, {
        dataset: datasetOf(),
        datasetTitle: "Awards",
        schemaId: datasetOf().id,
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /new analysis/i }));
  const sqlField = await screen.findByLabelText("SQL");
  fireEvent.change(sqlField, {
    target: { value: "SELECT state, count(*) AS n FROM source GROUP BY state" },
  });
  fireEvent.click(screen.getByRole("button", { name: /run query/i }));
}

const RESULT = {
  diagnostics: {
    coercedNulls: 0,
    resultRows: 2,
    tables: ["source"],
    totalSourceRows: 2,
    truncated: false,
  },
  rows: [
    { n: 1, state: "VT" },
    { n: 1, state: "NH" },
  ],
};

describe("PgAnalysisPanel — the PG run dispatch (#204)", () => {
  it("dispatches the run with backend pg, the source declared columns, and renders its rows", async () => {
    await openEditorAndRun();
    await waitFor(() => {
      expect(mocks.runAnalysis).toHaveBeenCalledTimes(1);
    });
    const firstCall = mocks.runAnalysis.mock.calls[0],
      request = firstCall === undefined ? undefined : firstCall[0];
    expect(request).toBeDefined();
    expect(request === undefined ? undefined : request.backend).toBe("pg");
    const source = request === undefined ? undefined : request.source;
    expect(source).toBeDefined();
    expect(source === undefined ? undefined : source.as).toBe("source");
    expect(source === undefined ? undefined : source.schemaId).toBe(datasetOf().id);
    expect(source === undefined ? undefined : source.title).toBe("Awards");
    // The declared columns ride the request (the typed-structures invariant
    // — the worker registers from the DECLARED structure, engine inference
    // only covers what rows carry beyond it).
    expect(source === undefined ? undefined : source.columns).toEqual(
      declaredColumnTypes(datasetOf().jsonSchema),
    );

    mocks.run(0).resolve(RESULT);
    expect(await screen.findByText("VT")).toBeDefined();
    expect(screen.getByText("NH")).toBeDefined();
  });

  it("a rejected run reports through the error toast, once", async () => {
    const { toast } = await import("sonner");
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
