// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The dialog's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    success: vi.fn<(message: string) => void>(),
  },
}));

// The session seam: a fixed signed-in creator, reference-stable per render
// pass (the app-vitest-config rule). Tests that need another viewer
// override the state handle.
const sessionState = vi.hoisted(() => ({
  session: { user: { id: "creator-1" } },
}));
vi.mock("@/integrations/supabase/provider", () => ({
  useSession: () => ({ isLoading: false, session: sessionState.session }),
}));

const { publishSpy } = vi.hoisted(() => ({
  publishSpy:
    vi.fn<
      (args: {
        datasetId: string;
        isDraft: boolean;
        lineage?: unknown;
        publishKey: string;
        versionLabel: string;
      }) => Promise<{ draftFlipped: boolean; versionId: string }>
    >(),
}));
vi.mock("../lib/pg-publish", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/pg-publish")>();
  return { ...actual, publishPgDatasetVersion: publishSpy };
});

import { toast } from "sonner";

import type { DatasetRow } from "@/lib/store/datasets";

import { PgPublishDialog } from "./pg-publish-dialog";

/** The locked open dataset the dialog's honesty rules hang off. */
function datasetOf(overrides: Partial<DatasetRow>): DatasetRow {
  return {
    bbox: null,
    createdAt: "2026-11-04T00:00:00+00:00",
    createdBy: "creator-1",
    description: null,
    editPolicy: "open",
    entryCount: 5,
    featureCount: 5,
    geometryType: null,
    groupId: null,
    id: "dataset-1",
    isGeospatial: false,
    jsonSchema: { properties: {}, title: "Sample" },
    lifecycle: "published",
    lineage: null,
    mapTileArchiveBytes: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileArchivePath: null,
    mapTileCacheVersion: 1,
    maxGeometryRowBytes: null,
    properties: [],
    publishedVisibility: "everyone",
    simplifyGeometry: false,
    source: null,
    sourceFileName: null,
    sourceFileSize: null,
    sourceFilePath: null,
    title: "Sample",
    updatedAt: "2026-11-04T00:00:00+00:00",
    ...overrides,
  };
}

const toastMock = vi.mocked(toast);

function renderDialog(dataset: Partial<DatasetRow>): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PgPublishDialog, {
        dataset: datasetOf(dataset),
        onOpenChange: () => undefined,
        open: true,
        publishKey: "01234567-89ab-cdef-0123-456789abcdef",
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PgPublishDialog", () => {
  it("requires a version label with an inline explanation and refuses an empty submit", async () => {
    renderDialog({});
    fireEvent.click(screen.getByRole("button", { name: /Publish version/ }));
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Give the version a label.");
    });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/A version label is required/)).toBeTruthy();
  });

  it("publishes through the seam with the dialog's idempotency key", async () => {
    publishSpy.mockResolvedValueOnce({ draftFlipped: false, versionId: "version-1" });
    renderDialog({});
    fireEvent.change(screen.getByLabelText("Version label"), { target: { value: "v1" } });
    fireEvent.click(screen.getByRole("button", { name: /Publish version/ }));
    await waitFor(() => {
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          datasetId: "dataset-1",
          isDraft: false,
          publishKey: "01234567-89ab-cdef-0123-456789abcdef",
          versionLabel: "v1",
        }),
      );
    });
    expect(toastMock.success).toHaveBeenCalled();
  });

  it("renders the locked denial with its reason — disabled WITH copy, never a silent no-op", () => {
    renderDialog({ createdBy: "someone-else", editPolicy: "locked" });
    expect(screen.getByText(/only its creator can publish/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Publish version/ }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("lets the locked dataset's CREATOR publish (the ADR 0010 carve-out is creator-only)", () => {
    renderDialog({ editPolicy: "locked" });
    expect(screen.getByRole("button", { name: /Publish version/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("warns on a draft that publishing will also list it in the catalog", () => {
    renderDialog({ lifecycle: "draft" });
    expect(screen.getByText(/This dataset is a draft/)).toBeTruthy();
  });
});
