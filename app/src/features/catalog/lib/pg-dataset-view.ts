import type { DatasetSummaryRow } from "#/lib/store/datasets";
import type { GroupRow } from "#/lib/store/groups";

/**
 * Pure view-model helpers for the Postgres catalog surfaces — the datasets
 * browser's PG items, the count labels, and the collection card counts. No
 * React, no queries: everything the routes and cards render is derived here
 * so the ui-polish parity rules (info parity across card types, counts next
 * to tags, hierarchical group presentation) have ONE
 * testable home. Data access lives in the store modules (`#/lib/store/*`);
 * nothing here reads or writes.
 */

/** The browser's sort options — newest, oldest, or by title. */
export type CatalogSortOption = "newest" | "oldest" | "title-asc";

/** The browser's type filter — PG datasets are geospatial or regular (`is_geospatial`). */
export type CatalogTypeFilter = "all" | "geospatial" | "regular";

/** One top-level PG item in the datasets browser: a group (members nested beneath it) or an ungrouped dataset. A grouped dataset is represented by its group, never top-level. */
export type PgBrowserItem =
  | { datasets: DatasetSummaryRow[]; group: GroupRow; kind: "group" }
  | { dataset: DatasetSummaryRow; kind: "dataset" };

/** True when `title`/`description` contains the (already normalized) search. */
function matchesSearch(normalized: string, title: string, description: string | null): boolean {
  return (
    title.toLowerCase().includes(normalized) ||
    (description !== null && description.toLowerCase().includes(normalized))
  );
}

/** The type filter against a PG summary (`isGeospatial` instead of the component's `kind` union). */
function matchesTypeFilter(dataset: DatasetSummaryRow, typeFilter: CatalogTypeFilter): boolean {
  if (typeFilter === "all") {
    return true;
  }
  return typeFilter === "geospatial" ? dataset.isGeospatial : !dataset.isGeospatial;
}

/**
 * Builds the PG browser's top-level items from the summaries and groups:
 * every group (with its member datasets attached) plus datasets without a
 * group. Ungrouped-yet filtering happens in `filterPgBrowserItems` — the
 * builder is the pure structural shape, so callers can count totals.
 */
export function buildPgBrowserItems(
  datasets: DatasetSummaryRow[],
  groups: GroupRow[],
): PgBrowserItem[] {
  const byGroup = new globalThis.Map<string, DatasetSummaryRow[]>();
  for (const dataset of datasets) {
    if (dataset.groupId !== null) {
      const members = byGroup.get(dataset.groupId);
      if (members === undefined) {
        byGroup.set(dataset.groupId, [dataset]);
      } else {
        members.push(dataset);
      }
    }
  }
  const items: PgBrowserItem[] = [];
  for (const dataset of datasets) {
    if (dataset.groupId === null) {
      items.push({ dataset, kind: "dataset" });
    }
  }
  for (const group of groups) {
    items.push({ datasets: byGroup.get(group.id) ?? [], group, kind: "group" });
  }
  return items;
}

/** The item's created-at as milliseconds — timestamps are ISO strings. */
export function pgBrowserItemSortTime(item: PgBrowserItem): number {
  const created = item.kind === "group" ? item.group.createdAt : item.dataset.createdAt;
  const parsed = Date.parse(created);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The item's display title — group name or dataset title. */
export function pgBrowserItemTitle(item: PgBrowserItem): string {
  return item.kind === "group" ? item.group.name : item.dataset.title;
}

/** Sorts PG items with the browser's sort options. */
export function sortPgBrowserItems(
  items: PgBrowserItem[],
  sort: CatalogSortOption,
): PgBrowserItem[] {
  return items.toSorted((a, b) => {
    if (sort === "title-asc") {
      return pgBrowserItemTitle(a).localeCompare(pgBrowserItemTitle(b));
    }
    const aTime = pgBrowserItemSortTime(a),
      bTime = pgBrowserItemSortTime(b);
    return sort === "oldest" ? aTime - bTime : bTime - aTime;
  });
}

/**
 * Applies the browser's search + type filter to browser items: a group matches when its own
 * name/description matches (then ALL its members show) or when any member
 * matches (then just those members show); an empty group stays visible only
 * on a self-match with no type filter.
 */
// oxlint-disable-next-line eslint/complexity -- splitting the group/dataset arms would scatter the parity rules this function exists to keep in one place.
export function filterPgBrowserItems(
  items: PgBrowserItem[],
  search: string,
  typeFilter: CatalogTypeFilter,
): PgBrowserItem[] {
  const normalized = search.trim().toLowerCase();
  if (normalized === "" && typeFilter === "all") {
    return items;
  }
  const visible: PgBrowserItem[] = [];
  for (const item of items) {
    if (item.kind === "dataset") {
      const dataset = item.dataset;
      if (
        matchesTypeFilter(dataset, typeFilter) &&
        (normalized === "" || matchesSearch(normalized, dataset.title, dataset.description))
      ) {
        visible.push(item);
      }
      continue;
    }
    const group = item.group,
      groupMatches = normalized !== "" && matchesSearch(normalized, group.name, group.description),
      visibleMembers = item.datasets.filter(
        (member) =>
          matchesTypeFilter(member, typeFilter) &&
          (normalized === "" ||
            groupMatches ||
            matchesSearch(normalized, member.title, member.description)),
      );
    const emptyGroupVisible = item.datasets.length === 0 && groupMatches && typeFilter === "all";
    if (visibleMembers.length > 0 || emptyGroupVisible) {
      visible.push({ datasets: visibleMembers, group, kind: "group" });
    }
  }
  return visible;
}

/**
 * The magnitude label next to a PG dataset's type tags (ui-polish count
 * parity): geospatial datasets read "N features" from the trigger-maintained
 * `feature_count` summary column, regular datasets "N rows" from
 * `entry_count` — never a client-side scan (stage 3's acceptance criterion).
 */
export function datasetCountLabel(dataset: DatasetSummaryRow): string {
  if (dataset.isGeospatial) {
    return `${dataset.featureCount} ${dataset.featureCount === 1 ? "feature" : "features"}`;
  }
  return `${dataset.entryCount} ${dataset.entryCount === 1 ? "row" : "rows"}`;
}

/**
 * How many datasets a PG collection holds: direct joins plus every dataset
 * of a group living in the collection (a group joins as a single unit and
 * brings its members), deduped by
 * dataset id so a dataset both joined and grouped never counts twice.
 */
export function collectionDatasetCount(
  memberships: Array<{ collectionId: string; datasetId: string }>,
  datasets: DatasetSummaryRow[],
  groups: Array<{ collectionId: string | null; id: string }>,
  collectionId: string,
): number {
  const memberGroupIds = new Set<string>();
  for (const group of groups) {
    if (group.collectionId === collectionId) {
      memberGroupIds.add(group.id);
    }
  }
  const ids = new Set<string>();
  for (const membership of memberships) {
    if (membership.collectionId === collectionId) {
      ids.add(membership.datasetId);
    }
  }
  for (const dataset of datasets) {
    if (dataset.groupId !== null && memberGroupIds.has(dataset.groupId)) {
      ids.add(dataset.id);
    }
  }
  return ids.size;
}

/**
 * The drafts toggle's merge — published and draft reads are disjoint; the id
 * guard keeps that observable.
 */
export function withPgDrafts(
  datasets: DatasetSummaryRow[] | undefined,
  drafts: DatasetSummaryRow[] | undefined,
  showDrafts: boolean,
): DatasetSummaryRow[] {
  if (datasets === undefined) {
    return [];
  }
  if (!showDrafts || drafts === undefined) {
    return datasets;
  }
  const publishedIds = new Set(datasets.map((dataset) => dataset.id));
  return [...datasets, ...drafts.filter((draft) => !publishedIds.has(draft.id))];
}
