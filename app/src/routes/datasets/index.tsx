import { Badge } from "@caden/ui/components/badge";
import { Card } from "@caden/ui/components/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import { cn } from "@caden/ui/lib/utils";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { Calendar, ChevronRight, FolderOpen, Layers, Plus, Search } from "lucide-react";
import { useState } from "react";

import {
  DerivedDatasetBadge,
  DatasetTypeTags,
  DerivedHealthBadges,
  SourceDriftBadges,
} from "#/components/dataset-type-tags";
import { RouterButton } from "#/components/router-button";
import { UserAvatar } from "#/components/user-avatar";
import {
  PgDatasetCard,
  PgGroupCard,
  SourceStoreBadge,
  buildPgBrowserItems,
  filterPgBrowserItems,
  mergeSortedItems,
  sortPgBrowserItems,
  withPgDrafts,
  type PgBrowserItem,
} from "#/features/catalog";
import { withDrafts } from "#/features/datasets";
import * as collectionsStore from "#/lib/store/collections";
import * as datasetsStore from "#/lib/store/datasets";
import * as groupsStore from "#/lib/store/groups";

import { api } from "../../../convex/_generated/api";

/** One per-source drift badge row, as `consumption.sourceBadges` returns it (stage 6, #101). */
type SourceBadge = FunctionReturnType<
  typeof api.versions.consumption.sourceBadges
>["bySchemaId"][string][number];

export const Route = createFileRoute("/datasets/")({
  component: DatasetsPage,
});

/** Both stores' items, interleaved by the merge (§14.6's split-brain browser) — the route's own `BrowserItem` union is the Convex half. */
type MergedBrowserItem = BrowserItem | PgBrowserItem;

/** True for a Postgres item: neither store's rows can carry the other's id field (Convex `_id` vs PG `id`). */
function isPgBrowserItem(item: MergedBrowserItem): item is PgBrowserItem {
  if (item.kind === "group") {
    return !("_id" in item.group);
  }
  return !("_id" in item.dataset);
}

/** The merge comparator's key for either store's item — Convex rows carry millisecond `_creationTime`s, PG rows ISO `createdAt`s. */
function mergedItemKey(item: MergedBrowserItem): { time: number; title: string } {
  if (item.kind === "group") {
    const group = item.group;
    return "_creationTime" in group
      ? { time: group._creationTime, title: group.name }
      : { time: Date.parse(group.createdAt), title: group.name };
  }
  const dataset = item.dataset;
  return "_creationTime" in dataset
    ? { time: dataset._creationTime, title: dataset.title }
    : { time: Date.parse(dataset.createdAt), title: dataset.title };
}

type SortOption = "newest" | "oldest" | "title-asc";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
  { label: "Title (A–Z)", value: "title-asc" },
];

type TypeFilter = "all" | "geospatial" | "regular";

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { label: "All", value: "all" },
  { label: "Geospatial", value: "geospatial" },
  { label: "Regular", value: "regular" },
];

type DatasetSummary = FunctionReturnType<typeof api.cms.schemas.listSummaries>[number];
type DerivedSummary = FunctionReturnType<typeof api.versions.derivedDatasets.summaries>[number];
type GroupSummary = FunctionReturnType<typeof api.cms.groups.list>[number];
type UserProfile = FunctionReturnType<typeof api.users.listProfiles>[number];

/**
 * Where a derived dataset's spec lives, for card linking: a component
 * dataset (link to its Transform tab — the authoring surface) or another
 * derived dataset (title only; first-class derived pages are stage 3).
 */
type DerivedCardSource =
  | { dataset: DatasetSummary; kind: "component" }
  | { dataset: DerivedSummary; kind: "derived" };

/**
 * One top-level item in the browser: either a group (whose member datasets
 * render nested right below it), an individual dataset, or a derived
 * dataset (registry row, badged; §3 — derived datasets appear in the
 * browser). Datasets that belong to a group are never top-level — the group
 * represents them.
 */
type BrowserItem =
  | { datasets: DatasetSummary[]; group: GroupSummary; kind: "group" }
  | { dataset: DatasetSummary; kind: "dataset" }
  | { dataset: DerivedSummary; kind: "derived" };

function matchesTypeFilter(dataset: DatasetSummary, typeFilter: TypeFilter): boolean {
  if (typeFilter === "all") {
    return true;
  }
  return typeFilter === "geospatial"
    ? dataset.kind === "geospatial"
    : dataset.kind !== "geospatial";
}

function matchesSearch(title: string, description: string | undefined, query: string): boolean {
  return (
    title.toLowerCase().includes(query) ||
    (description !== undefined && description.toLowerCase().includes(query))
  );
}

function itemCreatedTime(item: BrowserItem): number {
  return item.kind === "group" ? item.group._creationTime : item.dataset._creationTime;
}

function itemTitle(item: BrowserItem): string {
  return item.kind === "group" ? item.group.name : item.dataset.title;
}

function sortItems(items: BrowserItem[], sort: SortOption): BrowserItem[] {
  return items.toSorted((a, b) => {
    if (sort === "title-asc") {
      return itemTitle(a).localeCompare(itemTitle(b));
    }
    return sort === "oldest"
      ? itemCreatedTime(a) - itemCreatedTime(b)
      : itemCreatedTime(b) - itemCreatedTime(a);
  });
}

function FiltersSidebar({
  total,
  sort,
  onSort,
  typeFilter,
  onTypeFilterChange,
  showDrafts,
  onShowDraftsChange,
}: {
  total: number;
  sort: SortOption;
  onSort: (sort: SortOption) => void;
  typeFilter: TypeFilter;
  onTypeFilterChange: (typeFilter: TypeFilter) => void;
  showDrafts: boolean;
  onShowDraftsChange: (showDrafts: boolean) => void;
}) {
  return (
    <aside className="w-full shrink-0 md:w-64">
      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Filters</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {total} {total === 1 ? "result" : "results"}
        </p>

        <div className="mt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Type
          </p>
          <div className="flex flex-col gap-1">
            {TYPE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onTypeFilterChange(option.value);
                }}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-left text-sm transition-colors",
                  option.value === typeFilter
                    ? "border-primary/30 bg-primary/5 font-medium text-primary"
                    : "border-transparent text-muted-foreground hover:bg-muted",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Catalog
          </p>
          <button
            type="button"
            onClick={() => {
              onShowDraftsChange(!showDrafts);
            }}
            aria-pressed={showDrafts}
            className={cn(
              "w-full rounded-md border px-3 py-1.5 text-left text-sm transition-colors",
              showDrafts
                ? "border-primary/30 bg-primary/5 font-medium text-primary"
                : "border-transparent text-muted-foreground hover:bg-muted",
            )}
          >
            {showDrafts ? "Showing drafts" : "Show drafts"}
          </button>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Sort by
          </p>
          <div className="flex flex-col gap-1">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onSort(option.value);
                }}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-left text-sm transition-colors",
                  option.value === sort
                    ? "border-primary/30 bg-primary/5 font-medium text-primary"
                    : "border-transparent text-muted-foreground hover:bg-muted",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function DatasetCard({
  dataset,
  profile,
  badges,
}: {
  dataset: DatasetSummary;
  profile?: UserProfile;
  badges?: SourceBadge[];
}) {
  return (
    <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
      <Link
        to="/datasets/$schemaId"
        params={{ schemaId: dataset._id }}
        className="flex min-w-0 flex-1 flex-col gap-2 py-0"
      >
        <div className="flex flex-wrap items-center gap-2">
          {/* §14.6: the split-brain browser badges every card with its store. */}
          <SourceStoreBadge store="convex" />
          <DatasetTypeTags dataset={dataset} />
          <SourceDriftBadges badges={badges} />
          <span className="text-xs text-muted-foreground">
            {dataset.fieldCount} {dataset.fieldCount === 1 ? "field" : "fields"}
          </span>
        </div>
        <div>
          <h3 className="text-base font-semibold">{dataset.title}</h3>
          <p className="line-clamp-2 text-sm text-muted-foreground">{dataset.description}</p>
        </div>
        <div className="flex items-center text-xs text-muted-foreground">
          <Calendar className="mr-1.5 h-3.5 w-3.5" />
          Created {new Date(dataset._creationTime).toLocaleDateString()}
        </div>
      </Link>
      {/* A sibling link, not a nested one — anchors can't nest, and the
          creator chip must stay clickable inside the card. */}
      {dataset.createdBy !== undefined && profile !== undefined && (
        <Link
          to="/users/$userId"
          params={{ userId: dataset.createdBy }}
          className="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={`View ${profile.name ?? "this user"}'s profile`}
        >
          <UserAvatar className="h-4 w-4 text-[7px]" image={profile.image} name={profile.name} />
          {profile.name ?? "Unnamed"}
        </Link>
      )}
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
    </Card>
  );
}

/**
 * A derived dataset's browser card (§3 lines 84-86): badged as derived, with
 * its read-time health. It opens the SOURCE dataset's Transform tab — the
 * place its spec is authored and edited; first-class derived pages are
 * stage 3.
 */
function DerivedDatasetCard({
  dataset,
  source,
  badges,
}: {
  dataset: DerivedSummary;
  source: DerivedCardSource | undefined;
  badges?: SourceBadge[];
}) {
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SourceStoreBadge store="convex" />
        <DerivedDatasetBadge />
        <DerivedHealthBadges health={dataset.health} reason={dataset.healthReason} />
        <SourceDriftBadges badges={badges} />
      </div>
      <div>
        <h3 className="text-base font-semibold">{dataset.title}</h3>
        <p className="line-clamp-2 text-sm text-muted-foreground">{dataset.description}</p>
      </div>
      <div className="flex items-center text-xs text-muted-foreground">
        <Calendar className="mr-1.5 h-3.5 w-3.5" />
        Created {new Date(dataset._creationTime).toLocaleDateString()}
        {source !== undefined && (
          <>
            {" · Derived from "}
            {source.dataset.title}
            {source.kind === "derived" ? " (derived)" : ""}
          </>
        )}
      </div>
    </>
  );
  // The card links only when its source is a component dataset — the place
  // its spec is authored. A derived-of-derived card has no page to open yet
  // (stage 3), so it carries no navigation affordance.
  const linked = source !== undefined && source.kind === "component";
  return (
    <Card
      className={
        linked
          ? "flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md"
          : "flex-row items-center gap-4 px-4"
      }
    >
      {linked ? (
        <Link
          to="/datasets/$schemaId"
          params={{ schemaId: source.dataset._id }}
          search={(prev) => ({ ...prev, view: "transform" })}
          className="flex min-w-0 flex-1 flex-col gap-2 py-0"
        >
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-0">{body}</div>
      )}
      {linked && <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />}
    </Card>
  );
}

/** A group item: the group's own header row, with its member datasets listed directly beneath it. */
function GroupCard({
  group,
  members,
  collectionName,
  badgesBySchemaId,
}: {
  group: GroupSummary;
  members: DatasetSummary[];
  collectionName?: string;
  badgesBySchemaId?: Record<string, SourceBadge[]>;
}) {
  return (
    <Card className="flex-col gap-0 px-0 py-0 overflow-hidden">
      <Link
        to="/groups/$groupId"
        params={{ groupId: group._id }}
        className="flex flex-1 items-center gap-4 px-4 py-3 transition-shadow hover:bg-muted/40"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <SourceStoreBadge store="convex" />
            <Badge variant="outline">
              <Layers />
              Group
            </Badge>
            <span className="text-xs text-muted-foreground">
              {members.length === 1 ? "1 dataset" : `${members.length} datasets`}
            </span>
          </div>
          <div>
            <h3 className="text-base font-semibold">{group.name}</h3>
            <p className="line-clamp-1 text-sm text-muted-foreground">
              {group.description ?? (collectionName ? `In ${collectionName}` : "Standalone group")}
            </p>
          </div>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </Link>
      {members.length > 0 && (
        <ul className="border-t">
          {members.map((dataset) => (
            <li key={dataset._id} className="border-b last:border-b-0">
              <Link
                to="/datasets/$schemaId"
                params={{ schemaId: dataset._id }}
                className="flex flex-col gap-1 bg-muted/20 px-4 py-2 pl-8 hover:bg-muted/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <DatasetTypeTags dataset={dataset} />
                  <SourceDriftBadges
                    badges={
                      badgesBySchemaId === undefined ? undefined : badgesBySchemaId[dataset._id]
                    }
                  />
                </div>
                <p className="truncate text-sm font-medium">{dataset.title}</p>
                <p className="truncate text-xs text-muted-foreground">{dataset.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Builds the browser's top-level items from the raw datasets and groups:
 * groups (with their member datasets attached, filtered by the current
 * search/type filters) plus datasets without a group. Grouped datasets are
 * represented by their group, never listed at top level.
 */
// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function filterBrowserItems(
  datasets: DatasetSummary[] | undefined,
  groups: GroupSummary[] | undefined,
  derived: DerivedSummary[] | undefined,
  search: string,
  sort: SortOption,
  typeFilter: TypeFilter,
): BrowserItem[] {
  if (datasets === undefined || groups === undefined) {
    return [];
  }
  const normalized = search.trim().toLowerCase(),
    byGroup = new Map<string, DatasetSummary[]>();
  for (const dataset of datasets) {
    if (dataset.groupId !== undefined) {
      const members = byGroup.get(dataset.groupId);
      if (members !== undefined) {
        members.push(dataset);
      } else {
        byGroup.set(dataset.groupId, [dataset]);
      }
    }
  }

  const items: BrowserItem[] = [];
  for (const dataset of datasets) {
    if (dataset.groupId === undefined) {
      const matches =
        matchesTypeFilter(dataset, typeFilter) &&
        (normalized === "" || matchesSearch(dataset.title, dataset.description, normalized));
      if (matches) {
        items.push({ dataset, kind: "dataset" });
      }
    }
  }
  for (const group of groups) {
    const members = byGroup.get(group._id) ?? [],
      groupMatches = normalized !== "" && matchesSearch(group.name, group.description, normalized),
      visibleMembers = members.filter(
        (member) =>
          matchesTypeFilter(member, typeFilter) &&
          (normalized === "" ||
            groupMatches ||
            matchesSearch(member.title, member.description, normalized)),
      );
    // An empty group still shows when it matches the search (and no type
    // filter narrows the view) so it stays discoverable; under a type
    // filter it has nothing to show.
    const emptyGroupVisible = members.length === 0 && groupMatches && typeFilter === "all";
    if (visibleMembers.length > 0 || emptyGroupVisible) {
      items.push({ datasets: visibleMembers, group, kind: "group" });
    }
  }
  // Derived datasets are neither geospatial nor regular — they show under
  // the "all" filter, sorted among everything else.
  for (const item of derived ?? []) {
    if (
      typeFilter === "all" &&
      (normalized === "" || matchesSearch(item.title, item.description, normalized))
    ) {
      items.push({ dataset: item, kind: "derived" });
    }
  }

  return sortItems(items, sort);
}

/**
 * The browser's light queries, through the TanStack bridge (issue #58
 * part 5): they render from the persisted cache on a cold start and stay live
 * via WebSocket updates pushed into the same cache entries. The derived
 * summaries are the registry's list projection — the one app-side union
 * point with the component's summaries (stage 3's map layers and exports
 * read the same projection; the component's own projection is never
 * widened).
 */
function useBrowserLightQueries(showDrafts: boolean) {
  return {
    collections: useQuery({ ...convexQuery(api.cms.collections.list) }).data,
    datasets: useQuery({ ...convexQuery(api.cms.schemas.listSummaries, { limit: 1000 }) }).data,
    // The opt-in drafts read (roadmap 5a, #99): the server-side default
    // (`listSummaries`) never returns drafts, so the drafts toggle is what
    // subscribes — disabled means no payload and no subscription.
    drafts: useQuery({
      ...convexQuery(api.cms.schemas.listDraftSummaries, { limit: 1000 }),
      enabled: showDrafts,
    }).data,
    derived: useQuery({ ...convexQuery(api.versions.derivedDatasets.summaries, {}) }).data,
    groups: useQuery({ ...convexQuery(api.cms.groups.list, { limit: 500 }) }).data,
    // authId → display profile, for the cards' creator chips.
    profiles: useQuery({ ...convexQuery(api.users.listProfiles) }).data,
  };
}

/**
 * The Postgres half of the browser's reads (design §14.6: the interim
 * catalog is split-brain) — the store's summary projection (with the
 * trigger-maintained entry/feature counts the PG cards' count labels read),
 * the opt-in drafts view, the groups, and the collections (a group's
 * "In {collection}" line). Creator chips resolve per id inside the cards,
 * TanStack-deduped.
 */
function usePgBrowserQueries(showDrafts: boolean) {
  return {
    collections: useQuery(collectionsStore.listQueryOptions()).data,
    datasets: useQuery(datasetsStore.listSummariesQueryOptions()).data,
    drafts: useQuery({
      ...datasetsStore.listDraftSummariesQueryOptions(),
      enabled: showDrafts,
    }).data,
    groups: useQuery(groupsStore.listQueryOptions()).data,
  };
}

// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
function DatasetsPage() {
  const [search, setSearch] = useState(""),
    [sort, setSort] = useState<SortOption>("newest"),
    [typeFilter, setTypeFilter] = useState<TypeFilter>("all"),
    [showDrafts, setShowDrafts] = useState(false),
    { datasets, drafts, groups, collections, profiles, derived } =
      useBrowserLightQueries(showDrafts),
    pg = usePgBrowserQueries(showDrafts),
    collectionNames = new Map<string, string>();
  for (const collection of collections ?? []) {
    collectionNames.set(collection._id, collection.name);
  }
  const pgCollectionNames = new Map<string, string>();
  for (const collection of pg.collections ?? []) {
    pgCollectionNames.set(collection.id, collection.name);
  }
  const profilesByAuthId = new Map<string, UserProfile>();
  for (const profile of profiles ?? []) {
    profilesByAuthId.set(profile.authId, profile);
  }
  const allDatasets = withDrafts(datasets, drafts, showDrafts),
    pgAllDatasets = withPgDrafts(pg.datasets, pg.drafts, showDrafts);
  const componentById = new Map<string, DatasetSummary>();
  for (const dataset of allDatasets) {
    componentById.set(dataset._id, dataset);
  }
  const derivedById = new Map<string, DerivedSummary>();
  for (const item of derived ?? []) {
    derivedById.set(item._id, item);
  }
  // Stage 6 (#101): the source-drift badges for the visible consumer kinds —
  // derived cards (via their head completed attempt) and published rows with
  // recorded source versions. Keyed by the FULL lists, not the filtered
  // view, so searching never re-subscribes the query. The badge rows resolve
  // host-side; the component summaries projection stays untouched.
  const versionRowIds = allDatasets
    .filter(
      (dataset) =>
        dataset.lineage !== undefined && (dataset.lineage.sourceVersions ?? []).length > 0,
    )
    .map((dataset) => dataset._id);
  const driftBadges = useQuery({
    ...convexQuery(api.versions.consumption.sourceBadges, {
      registryIds: (derived ?? []).map((row) => row._id),
      schemaIds: versionRowIds,
    }),
  }).data;
  const collectionName = (collectionId: string | undefined) =>
      collectionId === undefined ? undefined : collectionNames.get(collectionId),
    pgCollectionName = (collectionId: string | null) =>
      collectionId === null ? undefined : pgCollectionNames.get(collectionId),
    derivedSourceOf = (sourceDatasetId: string): DerivedCardSource | undefined => {
      const component = componentById.get(sourceDatasetId);
      if (component !== undefined) {
        return { dataset: component, kind: "component" };
      }
      const derivedSource = derivedById.get(sourceDatasetId);
      return derivedSource === undefined ? undefined : { dataset: derivedSource, kind: "derived" };
    },
    // Each store filters + sorts its OWN items (the comparators differ in
    // shape), then the merge interleaves them (§14.6's split-brain order).
    convexVisible = filterBrowserItems(allDatasets, groups, derived, search, sort, typeFilter),
    pgVisible = sortPgBrowserItems(
      filterPgBrowserItems(buildPgBrowserItems(pgAllDatasets, pg.groups ?? []), search, typeFilter),
      sort,
    ),
    visible = mergeSortedItems(convexVisible, pgVisible, sort, mergedItemKey);

  if (
    datasets === undefined ||
    groups === undefined ||
    derived === undefined ||
    pg.datasets === undefined ||
    pg.groups === undefined
  ) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-primary mb-1">Datasets</h1>
          <p className="text-muted-foreground">
            Browse datasets and groups — grouped datasets are listed under their group
          </p>
        </div>
        <RouterButton to="/datasets/create">
          <Plus className="h-4 w-4 mr-2" />
          Create dataset
        </RouterButton>
      </div>

      {allDatasets.length === 0 &&
      groups.length === 0 &&
      derived.length === 0 &&
      pgAllDatasets.length === 0 &&
      (pg.groups ?? []).length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>No datasets yet</EmptyTitle>
            <EmptyDescription>Create a dataset to start managing your JSON data.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <RouterButton to="/datasets/create">
              <Plus className="h-4 w-4 mr-2" />
              Create your first dataset
            </RouterButton>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6 md:flex-row">
          <FiltersSidebar
            total={visible.length}
            sort={sort}
            onSort={setSort}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            showDrafts={showDrafts}
            onShowDraftsChange={setShowDrafts}
          />

          <div className="min-w-0 flex-1">
            <div className="relative mb-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
                placeholder="Search datasets and groups…"
                className="h-10 pl-9 text-sm"
              />
            </div>

            {visible.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center rounded-lg border px-4 text-center text-sm text-muted-foreground">
                {search
                  ? `Nothing matches "${search}".`
                  : typeFilter === "all"
                    ? "No datasets yet."
                    : `No ${typeFilter === "geospatial" ? "geospatial" : "regular"} datasets.`}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {visible.map((item) =>
                  isPgBrowserItem(item) ? (
                    item.kind === "group" ? (
                      <PgGroupCard
                        key={item.group.id}
                        collectionName={pgCollectionName(item.group.collectionId)}
                        item={item}
                      />
                    ) : (
                      <PgDatasetCard key={item.dataset.id} dataset={item.dataset} />
                    )
                  ) : item.kind === "group" ? (
                    <GroupCard
                      key={item.group._id}
                      group={item.group}
                      members={item.datasets}
                      collectionName={collectionName(item.group.collectionId)}
                      badgesBySchemaId={
                        driftBadges === undefined ? undefined : driftBadges.bySchemaId
                      }
                    />
                  ) : item.kind === "derived" ? (
                    <DerivedDatasetCard
                      key={item.dataset._id}
                      dataset={item.dataset}
                      source={derivedSourceOf(item.dataset.sourceDatasetId)}
                      badges={
                        driftBadges === undefined
                          ? undefined
                          : driftBadges.byRegistryId[item.dataset._id]
                      }
                    />
                  ) : (
                    <DatasetCard
                      key={item.dataset._id}
                      dataset={item.dataset}
                      profile={
                        item.dataset.createdBy === undefined
                          ? undefined
                          : profilesByAuthId.get(item.dataset.createdBy)
                      }
                      badges={
                        driftBadges === undefined
                          ? undefined
                          : driftBadges.bySchemaId[item.dataset._id]
                      }
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
