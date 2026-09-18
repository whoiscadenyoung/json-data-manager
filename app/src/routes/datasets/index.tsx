import { Link, createFileRoute } from "@tanstack/react-router";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import type { FunctionReturnType } from "convex/server";
import {
  Calendar,
  ChevronRight,
  FolderOpen,
  Layers,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";

import { RouterButton } from "#/components/router-button";
import { DatasetTypeTags } from "#/components/dataset-type-tags";
import { Badge } from "#/components/ui/badge";
import { Card } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import { fieldCount } from "#/lib/json-schema";
import { cn } from "#/lib/utils";

import { api } from "../../../convex/_generated/api";

export const Route = createFileRoute("/datasets/")({
  component: DatasetsPage,
});

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

type DatasetSummary = FunctionReturnType<typeof api.schemas.list>[number];
type GroupSummary = FunctionReturnType<typeof api.groups.list>[number];

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

/**
 * One top-level item in the browser: either a group (whose member datasets
 * render nested right below it) or an individual dataset. Datasets that
 * belong to a group are never top-level — the group represents them.
 */
type BrowserItem =
  | { datasets: DatasetSummary[]; group: GroupSummary; kind: "group" }
  | { dataset: DatasetSummary; kind: "dataset" };

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
}: {
  total: number;
  sort: SortOption;
  onSort: (sort: SortOption) => void;
  typeFilter: TypeFilter;
  onTypeFilterChange: (typeFilter: TypeFilter) => void;
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

function DatasetCard({ dataset }: { dataset: DatasetSummary }) {
  return (
    <Link to="/datasets/$schemaId" params={{ schemaId: dataset._id }} className="block">
      <Card className="flex-row items-center gap-4 px-4 transition-shadow hover:shadow-md">
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-0">
          <div className="flex flex-wrap items-center gap-2">
            <DatasetTypeTags dataset={dataset} />
            <span className="text-xs text-muted-foreground">
              {fieldCount(dataset.schema)} {fieldCount(dataset.schema) === 1 ? "field" : "fields"}
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
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </Card>
    </Link>
  );
}

/** A group item: the group's own header row, with its member datasets listed directly beneath it. */
function GroupCard({
  group,
  members,
  collectionName,
}: {
  group: GroupSummary;
  members: DatasetSummary[];
  collectionName?: string;
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
              {group.description ??
                (collectionName ? `In ${collectionName}` : "Standalone group")}
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
function filterBrowserItems(
  datasets: DatasetSummary[] | undefined,
  groups: GroupSummary[] | undefined,
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
      groupMatches =
        normalized !== "" && matchesSearch(group.name, group.description, normalized),
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

  return sortItems(items, sort);
}

/**
 * The browser's three light queries, through the TanStack bridge (issue #58
 * part 5): they render from the persisted cache on a cold start and stay live
 * via WebSocket updates pushed into the same cache entries.
 */
function useBrowserLightQueries() {
  return {
    collections: useQuery({ ...convexQuery(api.collections.list) }).data,
    datasets: useQuery({ ...convexQuery(api.schemas.list) }).data,
    groups: useQuery({ ...convexQuery(api.groups.list, {}) }).data,
  };
}

function DatasetsPage() {
  const { datasets, groups, collections } = useBrowserLightQueries(),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState<SortOption>("newest"),
    [typeFilter, setTypeFilter] = useState<TypeFilter>("all"),
    collectionNames = new Map<string, string>();
  for (const collection of collections ?? []) {
    collectionNames.set(collection._id, collection.name);
  }
  const collectionName = (collectionId: string | undefined) =>
      collectionId === undefined ? undefined : collectionNames.get(collectionId),
    visible = filterBrowserItems(datasets, groups, search, sort, typeFilter);

  if (datasets === undefined || groups === undefined) {
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

      {datasets.length === 0 && groups.length === 0 ? (
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
                  item.kind === "group" ? (
                    <GroupCard
                      key={item.group._id}
                      group={item.group}
                      members={item.datasets}
                      collectionName={collectionName(item.group.collectionId)}
                    />
                  ) : (
                    <DatasetCard key={item.dataset._id} dataset={item.dataset} />
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
