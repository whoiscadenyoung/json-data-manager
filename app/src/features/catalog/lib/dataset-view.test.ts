import { describe, expect, it } from "vitest";

import type { DatasetSummaryRow } from "#/lib/store/datasets";
import type { GroupRow } from "#/lib/store/groups";

import {
  buildCatalogItems,
  collectionDatasetCount,
  datasetCountLabel,
  filterCatalogItems,
  sortCatalogItems,
  withDrafts,
} from "./dataset-view";

/** One PG summary wire row with only the fields the view helpers read. */
function datasetRow(id: string, overrides: Partial<DatasetSummaryRow> = {}): DatasetSummaryRow {
  return {
    bbox: null,
    createdAt: "2026-11-03T00:00:00+00:00",
    createdBy: "user-1",
    description: null,
    editPolicy: "open",
    entryCount: 2,
    featureCount: 2,
    fieldCount: 3,
    geometryType: null,
    groupId: null,
    id,
    isGeospatial: false,
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
    title: `Dataset ${id}`,
    ...overrides,
  };
}

function groupRow(id: string, overrides: Partial<GroupRow> = {}): GroupRow {
  return {
    collectionId: null,
    createdAt: "2026-11-02T00:00:00+00:00",
    createdBy: "user-1",
    description: null,
    id,
    name: `Group ${id}`,
    updatedAt: "2026-11-02T00:00:00+00:00",
    ...overrides,
  };
}

describe("buildCatalogItems", () => {
  it("nests grouped datasets under their group and keeps ungrouped ones top-level", () => {
    const grouped = datasetRow("d1", { groupId: "g1" }),
      ungrouped = datasetRow("d2"),
      items = buildCatalogItems([grouped, ungrouped], [groupRow("g1")]);
    expect(items).toHaveLength(2);
    const groupItem = items.find((item) => item.kind === "group");
    expect(groupItem).toBeDefined();
    expect(groupItem !== undefined && groupItem.datasets.map((row) => row.id)).toStrictEqual([
      "d1",
    ]);
    const datasetItem = items.find((item) => item.kind === "dataset");
    expect(datasetItem !== undefined && datasetItem.dataset.id).toBe("d2");
  });

  it("keeps an empty group as a visible item (with no members)", () => {
    const items = buildCatalogItems([], [groupRow("g1")]);
    expect(items).toHaveLength(1);
    expect(items[0] !== undefined && items[0].kind).toBe("group");
  });
});

describe("filterCatalogItems", () => {
  it("shows ALL members when the group itself matches the search", () => {
    const items = buildCatalogItems(
      [
        datasetRow("d1", { groupId: "g1", title: "Rivers" }),
        datasetRow("d2", { groupId: "g1", title: "Roads" }),
      ],
      [groupRow("g1", { name: "Infrastructure" })],
    );
    const visible = filterCatalogItems(items, "infrastructure", "all");
    expect(visible).toHaveLength(1);
    const groupItem = visible[0];
    expect(groupItem !== undefined && groupItem.kind).toBe("group");
    expect(
      groupItem !== undefined && groupItem.kind === "group" && groupItem.datasets,
    ).toHaveLength(2);
  });

  it("shows only the matching members when a member matches the search", () => {
    const items = buildCatalogItems(
      [
        datasetRow("d1", { groupId: "g1", title: "Rivers" }),
        datasetRow("d2", { groupId: "g1", title: "Roads" }),
      ],
      [groupRow("g1", { name: "Infrastructure" })],
    );
    const visible = filterCatalogItems(items, "rivers", "all");
    expect(visible).toHaveLength(1);
    const groupItem = visible[0];
    expect(
      groupItem !== undefined &&
        groupItem.kind === "group" &&
        groupItem.datasets.map((row) => row.id),
    ).toStrictEqual(["d1"]);
  });

  it("applies the type filter to members and hides a filtered-out group", () => {
    const items = buildCatalogItems(
      [datasetRow("d1", { groupId: "g1", isGeospatial: true }), datasetRow("d2")],
      [groupRow("g1")],
    );
    // Under "geospatial": the group shows (its member matches) and the
    // ungrouped regular dataset d2 hides.
    const geospatial = filterCatalogItems(items, "", "geospatial");
    expect(geospatial).toHaveLength(1);
    expect(
      geospatial[0] !== undefined &&
        geospatial[0].kind === "group" &&
        geospatial[0].datasets.map((row) => row.id),
    ).toStrictEqual(["d1"]);
    // The group's only member is geospatial, so under "regular" the group
    // has nothing to show and disappears; d2 remains.
    const regular = filterCatalogItems(items, "", "regular");
    expect(regular).toHaveLength(1);
    expect(regular[0] !== undefined && regular[0].kind === "dataset").toBe(true);
    expect(regular[0] !== undefined && regular[0].kind === "dataset" && regular[0].dataset.id).toBe(
      "d2",
    );
  });

  it("keeps an empty group visible only on a self-match with no type filter", () => {
    const items = buildCatalogItems([], [groupRow("g1", { name: "Empty group" })]);
    expect(filterCatalogItems(items, "empty", "all")).toHaveLength(1);
    expect(filterCatalogItems(items, "empty", "geospatial")).toHaveLength(0);
    expect(filterCatalogItems(items, "nothing-matches", "all")).toHaveLength(0);
  });
});

describe("sortCatalogItems", () => {
  it("sorts by title, newest, and oldest", () => {
    const items = buildCatalogItems(
      [
        datasetRow("b", { createdAt: "2026-01-02T00:00:00+00:00", title: "Bravo" }),
        datasetRow("a", { createdAt: "2026-01-03T00:00:00+00:00", title: "Alpha" }),
      ],
      [],
    );
    expect(sortCatalogItems(items, "title-asc").map((item) => title(item))).toStrictEqual([
      "Alpha",
      "Bravo",
    ]);
    expect(sortCatalogItems(items, "newest").map((item) => title(item))).toStrictEqual([
      "Alpha",
      "Bravo",
    ]);
    expect(sortCatalogItems(items, "oldest").map((item) => title(item))).toStrictEqual([
      "Bravo",
      "Alpha",
    ]);
  });
});

/** The item's display title, for sort assertions. */
function title(item: ReturnType<typeof buildCatalogItems>[number]): string {
  return item.kind === "group" ? item.group.name : item.dataset.title;
}

describe("datasetCountLabel", () => {
  it("reads features from the trigger-maintained column for geospatial rows", () => {
    expect(datasetCountLabel(datasetRow("d", { featureCount: 1, isGeospatial: true }))).toBe(
      "1 feature",
    );
    expect(datasetCountLabel(datasetRow("d", { featureCount: 20000, isGeospatial: true }))).toBe(
      "20000 features",
    );
  });

  it("reads rows from the trigger-maintained column for regular rows", () => {
    expect(datasetCountLabel(datasetRow("d", { entryCount: 1, isGeospatial: false }))).toBe(
      "1 row",
    );
    expect(datasetCountLabel(datasetRow("d", { entryCount: 7, isGeospatial: false }))).toBe(
      "7 rows",
    );
  });
});

describe("collectionDatasetCount", () => {
  it("counts direct members plus group members, deduped", () => {
    const memberships = [
        { collectionId: "c1", datasetId: "d1" },
        { collectionId: "c2", datasetId: "d2" },
        // d1 also sits in group g1 of the same collection — counted ONCE.
        { collectionId: "c1", datasetId: "d3" },
      ],
      datasets = [
        datasetRow("d1", { groupId: "g1" }),
        datasetRow("d2"),
        datasetRow("d3", { groupId: "g1" }),
        datasetRow("d4", { groupId: "g2" }),
      ],
      groups = [groupRow("g1", { collectionId: "c1" }), groupRow("g2", { collectionId: "c2" })];
    expect(collectionDatasetCount(memberships, datasets, groups, "c1")).toBe(2);
    expect(collectionDatasetCount(memberships, datasets, groups, "c2")).toBe(2);
    expect(collectionDatasetCount(memberships, datasets, groups, "c3")).toBe(0);
  });
});

describe("withDrafts", () => {
  it("returns the published list unchanged when the toggle is off", () => {
    const published = [datasetRow("d1")];
    expect(withDrafts(published, [datasetRow("draft")], false)).toStrictEqual(published);
  });

  it("merges the drafts read in when toggled on, dropping duplicate ids", () => {
    const published = [datasetRow("d1")],
      drafts = [datasetRow("draft1"), datasetRow("d1")];
    const merged = withDrafts(published, drafts, true);
    expect(merged.map((row) => row.id)).toStrictEqual(["d1", "draft1"]);
  });
});
