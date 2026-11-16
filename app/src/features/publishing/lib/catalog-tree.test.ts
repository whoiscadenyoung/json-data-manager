import { describe, expect, it } from "vitest";

import {
  canMoveFolder,
  flattenTree,
  folderPath,
  itemCountIn,
  listEntries,
  resolveFolderId,
  subtreeIds,
  type BrowserEntry,
  type BrowserItem,
  type TreeFolder,
} from "./catalog-tree";

function folder(id: string, parentId: string | null, name = id): TreeFolder {
  return { id, name, parentId, updatedAt: "2026-11-16T00:00:00Z" };
}

function item(overrides: Partial<BrowserItem> & { membershipId: string }): BrowserItem {
  return {
    datasetId: `d-${overrides.membershipId}`,
    folderId: null,
    kind: "dataset",
    modifiedAt: "2026-11-16T00:00:00Z",
    rowCount: 0,
    title: overrides.membershipId,
    ...overrides,
  };
}

// Catalog / grants / fy24, Catalog / grants / fy23, Catalog / maps
const folders = [
  folder("grants", null, "Grants"),
  folder("fy24", "grants", "FY24"),
  folder("fy23", "grants", "FY23"),
  folder("maps", null, "Maps"),
];

const items = [
  item({ membershipId: "awards", folderId: "fy24", title: "Awards", rowCount: 500 }),
  item({ membershipId: "summary", folderId: "fy24", title: "Award summary", kind: "view" }),
  item({ membershipId: "states", title: "States", rowCount: 50 }),
  item({ membershipId: "corridors", folderId: "maps", title: "Corridors", rowCount: 9 }),
];

function names(entries: BrowserEntry[]): string[] {
  return entries.map((entry) => (entry.type === "folder" ? entry.folder.name : entry.item.title));
}

const base = {
  folderId: null,
  folders,
  items,
  kind: "all",
  search: "",
  sort: { descending: false, key: "name" },
} as const;

describe("catalog tree", () => {
  it("resolves the URL's folder, falling back to the root for a folder that is gone", () => {
    expect(resolveFolderId(folders, undefined)).toBeNull();
    expect(resolveFolderId(folders, "fy24")).toBe("fy24");
    expect(resolveFolderId(folders, "deleted")).toBeNull();
  });

  it("builds the path from the root down", () => {
    expect(folderPath(folders, "fy24").map((entry) => entry.name)).toStrictEqual([
      "Grants",
      "FY24",
    ]);
    expect(folderPath(folders, null)).toStrictEqual([]);
  });

  it("collects a folder's subtree and refuses moves into it", () => {
    expect([...subtreeIds(folders, "grants")].toSorted()).toStrictEqual(["fy23", "fy24", "grants"]);
    expect(canMoveFolder(folders, "grants", "fy24")).toBe(false);
    expect(canMoveFolder(folders, "grants", "grants")).toBe(false);
    // Already there: not a move.
    expect(canMoveFolder(folders, "fy24", "grants")).toBe(false);
    expect(canMoveFolder(folders, "fy24", null)).toBe(true);
    expect(canMoveFolder(folders, "fy24", "maps")).toBe(true);
  });

  it("flattens the tree depth-first with siblings by name", () => {
    expect(
      flattenTree(folders).map((entry) => `${entry.depth}:${entry.folder.name}`),
    ).toStrictEqual(["0:Grants", "1:FY23", "1:FY24", "0:Maps"]);
  });

  it("counts a folder's items including its subfolders'", () => {
    expect(itemCountIn(folders, items, "grants")).toBe(2);
    expect(itemCountIn(folders, items, "fy23")).toBe(0);
  });
});

describe("catalog listing", () => {
  it("lists the open folder: subfolders first, then its own items", () => {
    expect(names(listEntries(base))).toStrictEqual(["Grants", "Maps", "States"]);
    expect(names(listEntries({ ...base, folderId: "grants" }))).toStrictEqual(["FY23", "FY24"]);
    expect(names(listEntries({ ...base, folderId: "fy24" }))).toStrictEqual([
      "Award summary",
      "Awards",
    ]);
  });

  it("searches the whole project whichever folder is open, and carries each item's path", () => {
    const found = listEntries({ ...base, folderId: "maps", search: "award" });
    expect(names(found)).toStrictEqual(["Award summary", "Awards"]);
    const first = found[0];
    if (first === undefined || first.type !== "item") {
      throw new Error("Expected an item.");
    }
    expect(first.path.map((entry) => entry.name)).toStrictEqual(["Grants", "FY24"]);
    // Folders match by name too.
    expect(names(listEntries({ ...base, search: "fy2" }))).toStrictEqual(["FY23", "FY24"]);
  });

  it("filters by kind, keeping folders while browsing", () => {
    expect(names(listEntries({ ...base, folderId: "fy24", kind: "view" }))).toStrictEqual([
      "Award summary",
    ]);
    expect(names(listEntries({ ...base, kind: "view" }))).toStrictEqual(["Grants", "Maps"]);
    expect(names(listEntries({ ...base, kind: "dataset", search: "a" }))).toStrictEqual([
      "Awards",
      "States",
    ]);
  });

  it("sorts items by size, largest first when descending", () => {
    const sorted = listEntries({
      ...base,
      search: "s",
      sort: { descending: true, key: "rows" },
    });
    expect(names(sorted)).toStrictEqual([
      "Grants",
      "Maps",
      "Awards",
      "States",
      "Corridors",
      "Award summary",
    ]);
  });

  it("lists an item whose folder is gone at the root", () => {
    const orphan = [item({ membershipId: "lost", folderId: "deleted", title: "Lost" })];
    expect(names(listEntries({ ...base, folders: [], items: orphan }))).toStrictEqual(["Lost"]);
  });
});
