// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The card's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

// The compare body mounts the overlay map, whose import chain reaches
// maplibre's vite-specific worker imports — irrelevant here, so the map leg
// is stubbed out and never loads (the version-compare.test.tsx pattern).
vi.mock("./diff-overlay-map", () => ({ DiffOverlayMap: () => null }));

// toast calls are the actions' user-facing contract — recorded, never fired.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    success: vi.fn<(message: string) => void>(),
  },
}));

// Write spies, hoisted beside the store mocks so the factories bind the SAME
// instances the tests assert on. All the stores' writes answer a count.
const { createTagMock, pinModeMock, revertRefMock, retireTagMock, setKeepMock, syncRefMock } =
  vi.hoisted(() => ({
    createTagMock:
      vi.fn<(args: { datasetId: string; name: string; versionId: string }) => Promise<unknown>>(),
    pinModeMock:
      vi.fn<
        (args: {
          mode: "float" | "pin";
          pinnedRef?: string;
          pinnedVersionId?: string;
          referenceId: string;
        }) => Promise<number>
      >(),
    revertRefMock: vi.fn<(args: { referenceId: string; toRef: string }) => Promise<number>>(),
    retireTagMock: vi.fn<(args: { tagId: string }) => Promise<number>>(),
    setKeepMock: vi.fn<(args: { datasetKey: string; keep: number }) => Promise<number>>(),
    syncRefMock: vi.fn<(args: { referenceId: string }) => Promise<{ affected: number }>>(),
  }));

/**
 * The read fixtures, behind a MUTABLE state handle typed with the stores'
 * wire shapes: tests swap the listed rows by reassigning fields and the
 * afterEach restores them. The queryFns return the CURRENT array reference
 * each call — reference-stable per render pass (the app-vitest-config dedupe
 * rule) while still swappable.
 */
const state = vi.hoisted(
  (): {
    consumers: import("#/lib/store/versions").ConsumerReferenceRow[];
    delta: import("#/lib/store/versions").VersionDelta;
    overlayRows: { rows: import("#/lib/version-rows").VersionRow[]; truncated: boolean };
    retention: import("#/lib/store/versions").ResolvedRetentionPolicy;
    tags: import("#/lib/store/tags").TagRow[];
    versions: import("#/lib/store/versions").DatasetVersionRow[];
  } => ({
    consumers: [],
    delta: { added: 0, ops: [], removed: 0, truncated: false, updated: 0 },
    overlayRows: {
      rows: [
        { data: { label: "a", lat: 1, lng: 2 }, key: "a" },
        { data: { label: "b", lat: 3, lng: 4 }, key: "b" },
      ],
      truncated: false,
    },
    retention: { keepVersions: 10, pinnedRefs: [] },
    tags: [],
    versions: [],
  }),
);

vi.mock("#/lib/store/tags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/store/tags")>();
  return {
    ...actual,
    create: createTagMock,
    listQueryOptions: () => ({
      queryFn: async () => state.tags,
      queryKey: ["test:tags"],
    }),
    retire: retireTagMock,
  };
});

vi.mock("#/lib/store/versions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/store/versions")>();
  return {
    ...actual,
    consumedByQueryOptions: () => ({
      queryFn: async () => state.consumers,
      queryKey: ["test:consumers"],
    }),
    listVersionsQueryOptions: () => ({
      queryFn: async () => state.versions,
      queryKey: ["test:versions"],
    }),
    retentionPolicyQueryOptions: () => ({
      queryFn: async () => state.retention,
      queryKey: ["test:retention"],
    }),
    revertReference: revertRefMock,
    setKeepVersions: setKeepMock,
    setReferenceMode: pinModeMock,
    syncReference: syncRefMock,
    versionDeltaQueryOptions: () => ({
      queryFn: async () => state.delta,
      queryKey: ["test:delta"],
    }),
  };
});

vi.mock("../lib/pg-versioning", async (importOriginal) => {
  // The pure helpers stay actual; only the overlay read is stubbed.
  const actual = await importOriginal<typeof import("../lib/pg-versioning")>();
  return {
    ...actual,
    overlayRowsQueryOptions: () => ({
      queryFn: async () => state.overlayRows,
      queryKey: ["test:overlay-rows"],
    }),
  };
});

import { toast } from "sonner";

import type { ConsumerReferenceRow, DatasetVersionRow } from "#/lib/store/versions";

import { PgConsumersCard, PgVersionsCard } from "./pg-versions-card";

/** One chain row fixture. */
function versionOf(id: string, versionLabel: string, ref: string): DatasetVersionRow {
  return {
    createdAt: "2026-11-04T02:00:00+00:00",
    createdBy: "creator-1",
    datasetId: "dataset-1",
    id,
    lineage: null,
    publishKey: `key-${id}`,
    ref,
    versionLabel,
  };
}

/** One consumer reference fixture. */
function consumerOf(overrides: Partial<ConsumerReferenceRow>): ConsumerReferenceRow {
  return {
    consumerId: "map-layer-9",
    consumerKind: "map",
    createdAt: "2026-11-04T00:00:00+00:00",
    id: "consumer-2",
    mode: "pin",
    pinnedRef: "ref-v2",
    pinnedVersionId: "version-2",
    sourceDatasetId: "dataset-1",
    ...overrides,
  };
}

const THREE_CHAIN = [
  versionOf("version-3", "v3", "ref-v3"),
  versionOf("version-2", "v2", "ref-v2"),
  versionOf("version-1", "v1", "ref-v1"),
];
const LIVE_TAG = {
  createdAt: "2026-11-04T00:00:00+00:00",
  createdBy: "creator-1",
  datasetId: "dataset-1",
  id: "tag-live",
  name: "release",
  retiredAt: null,
  versionId: "version-1",
};
const RETIRED_TAG = {
  createdAt: "2026-11-04T00:00:00+00:00",
  createdBy: "creator-1",
  datasetId: "dataset-1",
  id: "tag-retired",
  name: "old-pin",
  retiredAt: "2026-11-04T01:00:00+00:00",
  versionId: "version-2",
};
const toastMock = vi.mocked(toast);

/** Renders under the query client + a lazily-constructed Convex client (the compare's skipped queries still read the context; nothing subscribes). */
function renderWithProviders(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const convex = new ConvexReactClient("http://127.0.0.1:3212");
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ConvexProvider, { client: convex }, ui),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.consumers = [];
  state.delta = { added: 0, ops: [], removed: 0, truncated: false, updated: 0 };
  state.retention = { keepVersions: 10, pinnedRefs: [] };
  state.tags = [];
  state.versions = [];
});

describe("PgVersionsCard", () => {
  it("renders the chain with labels, refs, and tag chips (retired ones marked, honest history)", async () => {
    state.tags = [LIVE_TAG, RETIRED_TAG];
    state.versions = THREE_CHAIN;
    renderWithProviders(
      createElement(PgVersionsCard, { datasetId: "dataset-1", datasetTitle: "SMART" }),
    );
    await waitFor(() => {
      expect(screen.getByText("v3")).toBeTruthy();
    });
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("ref-v3")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();
    expect(screen.getByText(/old-pin \(retired\)/)).toBeTruthy();
  });

  it("shows the empty-state copy before the first publish", async () => {
    renderWithProviders(
      createElement(PgVersionsCard, { datasetId: "dataset-1", datasetTitle: "SMART" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/No versions yet/)).toBeTruthy();
    });
  });

  it("refuses an empty tag name with an explanation and never calls the write (no silent no-op)", async () => {
    state.versions = THREE_CHAIN;
    renderWithProviders(
      createElement(PgVersionsCard, { datasetId: "dataset-1", datasetTitle: "SMART" }),
    );
    const tagButtons = await screen.findAllByRole("button", { name: "Tag" });
    fireEvent.click(tagButtons[0] ?? document.createElement("button"));
    fireEvent.click(await screen.findByRole("button", { name: /Tag this version/ }));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Give the tag a name.");
    });
    expect(createTagMock).not.toHaveBeenCalled();
  });

  it("surfaces the retire guard's refusal message verbatim when a consumer still pins the version (#126)", async () => {
    state.tags = [LIVE_TAG];
    state.versions = THREE_CHAIN;
    retireTagMock.mockRejectedValueOnce(
      new Error(
        "This version is pinned by a consumer — float or unpin that reference before retiring it.",
      ),
    );
    renderWithProviders(
      createElement(PgVersionsCard, { datasetId: "dataset-1", datasetTitle: "SMART" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retire tag release" }));
    fireEvent.click(screen.getByRole("button", { name: "Retire tag" }));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "This version is pinned by a consumer — float or unpin that reference before retiring it.",
      );
    });
  });

  it("opens the compare view on the store's delta query + the overlay position reads", async () => {
    state.versions = THREE_CHAIN;
    state.delta = {
      added: 1,
      ops: [
        {
          entryKey: "a",
          fields: [{ after: 2, name: "n" }],
          geometryChanged: false,
          op: "update",
        },
      ],
      removed: 0,
      truncated: false,
      updated: 1,
    };
    renderWithProviders(
      createElement(PgVersionsCard, { datasetId: "dataset-1", datasetTitle: "SMART" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Compare versions/ }));
    await waitFor(() => {
      // The badges render from the STORE's delta — the inputs flow end to end.
      expect(screen.getByText("+1")).toBeTruthy();
    });
    expect(screen.getByText("~1")).toBeTruthy();
  });

  it("rejects a non-positive keep count with the recorded copy", async () => {
    state.versions = THREE_CHAIN;
    renderWithProviders(
      createElement(PgVersionsCard, { datasetId: "dataset-1", datasetTitle: "SMART" }),
    );
    const input = await screen.findByDisplayValue("10");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Keep must be a positive whole number.");
    });
    expect(setKeepMock).not.toHaveBeenCalled();
  });

  it("toasts the retention pass's retired count after a save", async () => {
    state.versions = THREE_CHAIN;
    setKeepMock.mockResolvedValueOnce(2);
    renderWithProviders(
      createElement(PgVersionsCard, { datasetId: "dataset-1", datasetTitle: "SMART" }),
    );
    const input = await screen.findByDisplayValue("10");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(setKeepMock).toHaveBeenCalledWith({ datasetKey: "dataset-1", keep: 3 });
      expect(toastMock.success).toHaveBeenCalledWith(
        "Keeping the newest 3 versions — 2 past it retired now.",
      );
    });
  });
});

describe("PgConsumersCard", () => {
  it("lists consumers with their float/pin state, the changed badge, and all three actions", async () => {
    state.consumers = [
      consumerOf({
        consumerId: "derived-row-1",
        consumerKind: "derived",
        id: "consumer-1",
        mode: "float",
        pinnedRef: null,
        pinnedVersionId: null,
      }),
      consumerOf({}),
    ];
    state.versions = THREE_CHAIN;
    renderWithProviders(createElement(PgConsumersCard, { datasetId: "dataset-1" }));
    await waitFor(() => {
      expect(screen.getByText("derived-row-1")).toBeTruthy();
    });
    expect(screen.getByText("map-layer-9")).toBeTruthy();
    expect(screen.getByText(/Transform spec · floats on head/)).toBeTruthy();
    expect(screen.getByText(/Map layer · pinned to ref-v2/)).toBeTruthy();
    // Pinned to v2 while the head is v3 — changed, syncable, revertible to v1.
    expect(screen.getByText("changed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pin to head" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync to head" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revert" })).toBeTruthy();
  });

  it("pins a floater through setReferenceMode carrying the head's version + ref", async () => {
    state.consumers = [
      consumerOf({
        consumerId: "derived-row-1",
        consumerKind: "derived",
        id: "consumer-1",
        mode: "float",
        pinnedRef: null,
        pinnedVersionId: null,
      }),
    ];
    state.versions = THREE_CHAIN;
    pinModeMock.mockResolvedValueOnce(1);
    renderWithProviders(createElement(PgConsumersCard, { datasetId: "dataset-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pin to head" }));
    await waitFor(() => {
      expect(pinModeMock).toHaveBeenCalledWith({
        mode: "pin",
        pinnedRef: "ref-v3",
        pinnedVersionId: "version-3",
        referenceId: "consumer-1",
      });
      expect(toastMock.success).toHaveBeenCalledWith("Pinned to the current head.");
    });
  });

  it("reverts through the store's toRef contract at the prior version", async () => {
    state.consumers = [consumerOf({})];
    state.versions = THREE_CHAIN;
    revertRefMock.mockResolvedValueOnce(1);
    renderWithProviders(createElement(PgConsumersCard, { datasetId: "dataset-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revert" }));
    await waitFor(() => {
      expect(revertRefMock).toHaveBeenCalledWith({ referenceId: "consumer-2", toRef: "ref-v1" });
      expect(toastMock.success).toHaveBeenCalledWith("Repinned to v1.");
    });
  });

  it("shows the honest muted revert (with the reason) when the pin sits at the first version", async () => {
    state.consumers = [consumerOf({ pinnedRef: "ref-v1", pinnedVersionId: "version-1" })];
    state.versions = THREE_CHAIN;
    renderWithProviders(createElement(PgConsumersCard, { datasetId: "dataset-1" }));
    const muted = await screen.findByTitle(
      "Already at the first version — nothing older to revert to.",
    );
    expect(muted.textContent).toContain("Revert");
    expect(screen.queryByRole("button", { name: "Revert" })).toBeNull();
  });
});
