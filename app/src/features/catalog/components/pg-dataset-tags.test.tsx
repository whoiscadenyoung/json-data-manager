// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DatasetSummaryRow } from "#/lib/store/datasets";

import { PgDatasetTagsWithCount, PgDatasetTypeTags } from "./pg-dataset-tags";

/** One PG summary wire row with only the fields the tags read. */
function datasetRow(overrides: Partial<DatasetSummaryRow> = {}): DatasetSummaryRow {
  return {
    bbox: null,
    createdAt: "2026-11-03T00:00:00+00:00",
    createdBy: "7e6c3a58-2f31-4a5b-9d29-0d59f2f1a000",
    description: null,
    editPolicy: "open",
    entryCount: 12,
    featureCount: 3,
    fieldCount: 4,
    geometryType: "Point",
    groupId: null,
    id: "7e6c3a58-2f31-4a5b-9d29-0d59f2f1a001",
    isGeospatial: true,
    lifecycle: "published",
    lineage: null,
    kind: "source",
    refreshMode: null,
    stale: false,
    mapTileArchiveBytes: null,
    mapTileArchiveBuiltVersion: null,
    mapTileArchiveFormat: null,
    mapTileArchiveMaxZoom: null,
    mapTileCacheVersion: 1,
    visibility: "signed-in",
    source: null,
    title: "Sample",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("PgDatasetTypeTags", () => {
  it("renders the Geospatial tag plus the geometry type", () => {
    render(<PgDatasetTypeTags dataset={datasetRow()} />);
    expect(screen.getByText("Geospatial")).toBeTruthy();
    expect(screen.getByText("Point")).toBeTruthy();
  });

  it("renders the Regular tag for a standard dataset", () => {
    render(<PgDatasetTypeTags dataset={datasetRow({ geometryType: null, isGeospatial: false })} />);
    expect(screen.getByText("Regular")).toBeTruthy();
    expect(screen.queryByText("Geospatial")).toBeNull();
  });

  it("marks author-visibility, drafts, and locks (the Convex tag set's info parity)", () => {
    render(
      <PgDatasetTypeTags
        dataset={datasetRow({
          editPolicy: "locked",
          lifecycle: "draft",
          visibility: "members",
        })}
      />,
    );
    expect(screen.getByText("Members only")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Locked")).toBeTruthy();
  });
});

describe("PgDatasetTagsWithCount", () => {
  it("shows the trigger-maintained feature count for geospatial rows", () => {
    render(<PgDatasetTagsWithCount dataset={datasetRow({ featureCount: 3 })} />);
    expect(screen.getByText("3 features")).toBeTruthy();
  });

  it("shows the trigger-maintained row count for regular rows", () => {
    render(
      <PgDatasetTagsWithCount
        dataset={datasetRow({ entryCount: 12, geometryType: null, isGeospatial: false })}
      />,
    );
    expect(screen.getByText("12 rows")).toBeTruthy();
    // Never both labels — one dataset, one magnitude (the count-parity rule).
    expect(screen.queryByText(/feature/)).toBeNull();
  });
});
