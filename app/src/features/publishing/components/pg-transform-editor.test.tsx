import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, act } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The editor's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// The autosave race (issue #135, defect 2), re-proved over the store's save
// seam (stage 5): the PG editor writes through `#/lib/store/derived`, so the
// store module is mocked at its boundary and the queries ride the mocked
// `useQuery` (routed by queryKey). The preview stub keeps the test hermetic
// — the race lives in the editor's autosave effect, not the preview.
const mocks = vi.hoisted(() => ({
  remove: vi.fn<(args: { id: string }) => Promise<number>>(async () => 1),
  save: vi.fn<(args: unknown) => Promise<string>>(async () => "row-1"),
  useQuery: vi.fn<(options: { queryKey: unknown[] }) => unknown>(),
}));

vi.mock("#/lib/store/derived", () => ({
  getQueryOptions: (args: { id: string }) => ({ queryKey: ["pg:derived", "get", args] }),
  listBySourceQueryOptions: (args: { sourceDatasetId: string }) => ({
    queryKey: ["pg:derived", "listBySource", args],
  }),
  remove: mocks.remove,
  save: mocks.save,
}));

vi.mock("@/integrations/supabase/provider", () => ({
  useSession: () => ({ isLoading: false, session: { user: { id: "creator-1" } } }),
}));

vi.mock("./pg-transform-preview", () => ({
  PgTransformPreview: () => <div data-testid="pg-preview-stub" />,
}));

vi.mock("#/features/catalog", () => ({
  PgDatasetPickerSheet: () => null,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQuery: mocks.useQuery,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(...args: unknown[]) => void>(),
    success: vi.fn<(...args: unknown[]) => void>(),
  },
}));

import { PgTransformEditor } from "./pg-transform-editor";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** A stored registry row whose spec's one lookup step is complete (the autosave gate's `completedCount > 0`). */
function savedDoc() {
  return {
    createdAt: "2026-11-04T00:00:00+00:00",
    createdBy: "creator-1",
    dependsOn: ["schema-1", "lookup-1"],
    description: null,
    health: "ready" as const,
    id: "row-1",
    sourceDatasetId: "schema-1",
    sourceDerivedId: null,
    spec: {
      operations: [
        {
          baseKey: "grantId",
          kind: "lookup",
          lookupDatasetId: "lookup-1",
          lookupKey: "id",
        },
      ],
      sourceDatasetId: "schema-1",
    },
    status: "saved" as const,
    title: "Enriched sites",
    updatedAt: "2026-11-04T00:00:00+00:00",
  };
}

/** The summaries row the picker's candidate list resolves the picked dataset through. */
function candidate() {
  return {
    bbox: null,
    createdAt: "2026-11-04T00:00:00+00:00",
    createdBy: "creator-1",
    description: null,
    editPolicy: "open" as const,
    entryCount: 1,
    featureCount: 0,
    fieldCount: 1,
    geometryType: null,
    id: "lookup-1",
    isGeospatial: false,
    lifecycle: "published" as const,
    lineage: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveBytes: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileCacheVersion: 1,
    publishedVisibility: "everyone" as const,
    source: null,
    title: "Lookups",
  };
}

/** Routes the editor's queries by key shape: the stored row rides ["pg:derived","get"], the catalog list rides ["pg:datasets","listSummaries"], and a picked dataset's point read (["pg:datasets","get"]) gets a minimal schema doc for the column pickers. */
function stubQueries(doc: unknown) {
  mocks.useQuery.mockImplementation((options: { queryKey: unknown[] }) => {
    const key = options.queryKey,
      domain = key[0],
      kind = key[1];
    if (domain === "pg:derived") {
      return { data: doc };
    }
    if (domain === "pg:datasets" && kind === "get") {
      return {
        data: {
          id: "lookup-1",
          jsonSchema: { properties: { id: { type: "string" } } },
          title: "Lookups",
        },
      };
    }
    if (domain === "pg:datasets") {
      return { data: [candidate()] };
    }
    return { data: undefined };
  });
}

/** A save whose calls settle under test control, in order, recording each payload. */
function controlledSave() {
  const resolvers: Array<(id: string) => void> = [],
    calls: unknown[] = [];
  mocks.save.mockImplementation(async (args: unknown) => {
    calls.push(args);
    return new Promise<string>((resolve) => {
      resolvers.push(resolve);
    });
  });
  return {
    calls,
    resolveNext: (id: string) => {
      const resolve = resolvers.shift();
      if (resolve === undefined) {
        throw new Error("no pending save call to resolve");
      }
      resolve(id);
    },
  };
}

function renderEditor() {
  return render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(PgTransformEditor, {
        columns: ["grantId"],
        datasetTitle: "Sites",
        docId: "row-1",
        onClose: () => {},
        schemaId: "schema-1",
      }),
    ),
  );
}

function typeTitle(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>("#transform-title");
  if (input === null) {
    throw new Error("the transform title input is not rendered");
  }
  fireEvent.change(input, { target: { value } });
}

describe("PgTransformEditor autosave race over the store seam (issue #135, stage 5)", () => {
  it("an edit made while a save is in flight survives it: dirty stays armed, the follow-up save patches the same row with the newer content", async () => {
    vi.useFakeTimers();
    stubQueries(savedDoc());
    const { calls, resolveNext } = controlledSave();
    const { container } = renderEditor();

    // Arm the autosave: an edit on top of the stored row.
    typeTitle(container, "V1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ id: "row-1", status: "draft", title: "V1" });

    // Edit while the first save is still in flight.
    typeTitle(container, "V2");
    resolveNext("row-1");
    await act(async () => {
      await Promise.resolve();
    });

    // The stale save must NOT have cleared `dirty` — the edit re-arms the
    // debounce, and the follow-up save carries the newer title on the SAME
    // row id (never a duplicate draft, never a dropped edit).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(calls[1]).toMatchObject({ id: "row-1", status: "draft", title: "V2" });

    resolveNext("row-1");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it("closing inside the 800 ms debounce window flushes the edit instead of dropping it", async () => {
    vi.useFakeTimers();
    stubQueries(savedDoc());
    const { calls, resolveNext } = controlledSave();
    const { container, unmount } = renderEditor();

    typeTitle(container, "Unsaved title");
    // Only part of the debounce window elapses before the editor closes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(mocks.save).not.toHaveBeenCalled();

    unmount();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ id: "row-1", status: "draft", title: "Unsaved title" });
    resolveNext("row-1");
    await act(async () => {
      await Promise.resolve();
    });
  });
});
