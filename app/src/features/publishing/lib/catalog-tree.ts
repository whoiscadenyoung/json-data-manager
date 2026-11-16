/**
 * Pure helpers behind the catalog's file browser: the folder tree (paths,
 * descendants, the "Move to" choices) and the listing of one folder (folders
 * first, then items, filtered and sorted). No React, no store calls.
 */

/** The folder fields the browser reads (a `ProjectFolderRow` fits). */
export interface TreeFolder {
  id: string;
  name: string;
  parentId: string | null;
  updatedAt: string;
}

/** What a catalog item is: a source dataset, a view, or a reference whose dataset is gone. */
export type CatalogItemKind = "dataset" | "view" | "missing";

/** One catalog item as the browser lists it (one project membership). */
export interface BrowserItem {
  /** The membership row id — what a move writes. */
  membershipId: string;
  /** The dataset id — what the row links to. */
  datasetId: string;
  folderId: string | null;
  kind: CatalogItemKind;
  title: string;
  rowCount: number | null;
  /** ISO timestamp of the last change; null when unknown. */
  modifiedAt: string | null;
}

export type KindFilter = "all" | "dataset" | "view";
export type SortKey = "name" | "rows" | "modified";
export interface SortState {
  key: SortKey;
  descending: boolean;
}

/** One listed row: a folder (with how much it holds) or an item. */
export type BrowserEntry =
  | { type: "folder"; folder: TreeFolder; itemCount: number }
  | { type: "item"; item: BrowserItem; path: TreeFolder[] };

/**
 * The folder the browser shows for a URL's `folder` value: the id itself
 * when that folder exists, otherwise the root (a deleted folder's link opens
 * the catalog rather than an empty page).
 */
export function resolveFolderId(
  folders: readonly TreeFolder[],
  requested: string | undefined,
): string | null {
  if (requested === undefined) {
    return null;
  }
  return folders.some((folder) => folder.id === requested) ? requested : null;
}

/** The folders from the root down to `folderId` (inclusive); empty for the root. */
export function folderPath(folders: readonly TreeFolder[], folderId: string | null): TreeFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder])),
    path: TreeFolder[] = [];
  let cursor = folderId;
  // The hop cap guards a corrupt (cyclic) tree; the database refuses cycles.
  for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
    const folder = byId.get(cursor);
    if (folder === undefined) {
      break;
    }
    path.unshift(folder);
    cursor = folder.parentId;
  }
  return path;
}

/** `folderId` and every folder beneath it. */
export function subtreeIds(folders: readonly TreeFolder[], folderId: string): Set<string> {
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Whether a folder may move under `targetId`: never into itself, its own subtree, or where it already is. */
export function canMoveFolder(
  folders: readonly TreeFolder[],
  folderId: string,
  targetId: string | null,
): boolean {
  const folder = folders.find((candidate) => candidate.id === folderId);
  if (folder === undefined || folder.parentId === targetId) {
    return false;
  }
  return targetId === null || !subtreeIds(folders, folderId).has(targetId);
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

/** The whole tree, depth-first with siblings by name — the "Move to" list. */
export function flattenTree(
  folders: readonly TreeFolder[],
): { depth: number; folder: TreeFolder }[] {
  const known = new Set(folders.map((folder) => folder.id)),
    flat: { depth: number; folder: TreeFolder }[] = [],
    visit = (parentId: string | null, depth: number): void => {
      const children = folders
        .filter((folder) =>
          parentId === null
            ? // A folder whose parent is missing lists at the top rather than vanishing.
              folder.parentId === null || !known.has(folder.parentId)
            : folder.parentId === parentId,
        )
        .toSorted(byName);
      for (const folder of children) {
        flat.push({ depth, folder });
        if (depth < 64) {
          visit(folder.id, depth + 1);
        }
      }
    };
  visit(null, 0);
  return flat;
}

/** How many catalog items sit in a folder, counting its subfolders' items. */
export function itemCountIn(
  folders: readonly TreeFolder[],
  items: readonly BrowserItem[],
  folderId: string,
): number {
  const ids = subtreeIds(folders, folderId);
  return items.filter((item) => item.folderId !== null && ids.has(item.folderId)).length;
}

function compareItems(sort: SortState): (left: BrowserItem, right: BrowserItem) => number {
  const direction = sort.descending ? -1 : 1;
  return (left, right) => {
    let order = 0;
    if (sort.key === "rows") {
      order = (left.rowCount ?? -1) - (right.rowCount ?? -1);
    } else if (sort.key === "modified") {
      order = (left.modifiedAt ?? "").localeCompare(right.modifiedAt ?? "");
    }
    return order === 0
      ? byName({ name: left.title }, { name: right.title }) * (sort.key === "name" ? direction : 1)
      : order * direction;
  };
}

function compareFolders(sort: SortState): (left: TreeFolder, right: TreeFolder) => number {
  const direction = sort.descending ? -1 : 1;
  return (left, right) => {
    if (sort.key === "modified") {
      const order = left.updatedAt.localeCompare(right.updatedAt);
      if (order !== 0) {
        return order * direction;
      }
    }
    return byName(left, right) * (sort.key === "name" ? direction : 1);
  };
}

/**
 * What the browser lists.
 *
 * Without a search: the open folder's subfolders, then its items. With a
 * search: every matching folder and item of the WHOLE project (a search is
 * for finding, so it ignores which folder is open), each item carrying its
 * path. The kind filter hides the other kind of item, and hides folders
 * while it is on during a search.
 */
export function listEntries(args: {
  folders: readonly TreeFolder[];
  items: readonly BrowserItem[];
  folderId: string | null;
  search: string;
  kind: KindFilter;
  sort: SortState;
}): BrowserEntry[] {
  const { folders, items, kind, sort } = args,
    needle = args.search.trim().toLowerCase(),
    searching = needle !== "",
    known = new Set(folders.map((folder) => folder.id)),
    // An item whose folder is gone lists at the root.
    homeOf = (item: BrowserItem): string | null =>
      item.folderId !== null && known.has(item.folderId) ? item.folderId : null,
    kindMatches = (item: BrowserItem): boolean =>
      kind === "all" || (kind === "view" ? item.kind === "view" : item.kind !== "view"),
    shownFolders = searching
      ? kind === "all"
        ? folders.filter((folder) => folder.name.toLowerCase().includes(needle))
        : []
      : folders.filter((folder) => folder.parentId === args.folderId),
    shownItems = items.filter(
      (item) =>
        kindMatches(item) &&
        (searching ? item.title.toLowerCase().includes(needle) : homeOf(item) === args.folderId),
    );
  return [
    ...shownFolders.toSorted(compareFolders(sort)).map((folder): BrowserEntry => ({
      folder,
      itemCount: itemCountIn(folders, items, folder.id),
      type: "folder",
    })),
    ...shownItems.toSorted(compareItems(sort)).map((item): BrowserEntry => ({
      item,
      path: folderPath(folders, homeOf(item)),
      type: "item",
    })),
  ];
}
