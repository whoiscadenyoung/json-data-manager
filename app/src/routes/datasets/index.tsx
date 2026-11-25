import { Button } from "@caden/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@caden/ui/components/empty";
import { Input } from "@caden/ui/components/input";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Plus, Search } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "#/components/page-header";
import {
  DatasetCard,
  GroupCard,
  buildCatalogItems,
  filterCatalogItems,
  sortCatalogItems,
  withDrafts,
  type CatalogItem,
} from "#/features/catalog";
import { DatasetCardAddToProjectButton, ProjectTargetSheet } from "#/features/publishing";
import * as collectionsStore from "#/lib/store/collections";
import * as datasetsStore from "#/lib/store/datasets";
import * as groupsStore from "#/lib/store/groups";
import * as projectsStore from "#/lib/store/projects";

/**
 * The browser's reads — the store's summary projection (with the
 * trigger-maintained entry/feature counts the PG cards' count labels read),
 * the opt-in drafts view, the groups, the collections (a group's
 * "In {collection}" line), and the visible artifact memberships (the
 * per-card "in project" chips; issue #262).
 */
function useBrowserQueries(showDrafts: boolean) {
  return {
    collections: useQuery(collectionsStore.listQueryOptions()).data,
    datasets: useQuery(datasetsStore.listSummariesQueryOptions()).data,
    drafts: useQuery({
      ...datasetsStore.listDraftSummariesQueryOptions(),
      enabled: showDrafts,
    }).data,
    groups: useQuery(groupsStore.listQueryOptions()).data,
    memberships: useQuery(projectsStore.listVisibleArtifactMembershipsQueryOptions()).data,
  };
}

export const Route = createFileRoute("/datasets/")({
  component: DatasetsPage,
});

const SORT_OPTIONS = [
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
  { label: "Title (A–Z)", value: "title-asc" },
] as const;

type SortOption = (typeof SORT_OPTIONS)[number]["value"];

const TYPE_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Geospatial", value: "geospatial" },
  { label: "Regular", value: "regular" },
] as const;

type TypeFilter = (typeof TYPE_OPTIONS)[number]["value"];

/**
 * The datasets browser: datasets and groups, drafts behind the opt-in
 * toggle. Derived datasets render from the Transform tab and the project
 * workspaces. The filters sidebar (FiltersSidebar + its option sets) drives
 * the search/type behavior.
 */
function FiltersSidebar(props: {
  onShowDraftsChange: (show: boolean) => void;
  onSort: (sort: SortOption) => void;
  onTypeFilterChange: (filter: TypeFilter) => void;
  showDrafts: boolean;
  sort: SortOption;
  total: number;
  typeFilter: TypeFilter;
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col gap-6 md:w-56">
      <div>
        <p className="mb-2 text-sm font-medium">Sort</p>
        <div className="flex flex-col gap-1">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                props.onSort(option.value);
              }}
              className={
                props.sort === option.value
                  ? "rounded-md bg-muted px-3 py-1.5 text-left text-sm font-medium"
                  : "rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Type</p>
        <div className="flex flex-col gap-1">
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                props.onTypeFilterChange(option.value);
              }}
              className={
                props.typeFilter === option.value
                  ? "rounded-md bg-muted px-3 py-1.5 text-left text-sm font-medium"
                  : "rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          checked={props.showDrafts}
          onChange={(e) => {
            props.onShowDraftsChange(e.target.checked);
          }}
          type="checkbox"
        />
        Show drafts
      </label>
      <p className="text-xs text-muted-foreground">{props.total} shown</p>
    </aside>
  );
}

// oxlint-disable-next-line eslint/complexity -- the browser's search/sort/filter render paths are the page's real shape.
function DatasetsPage() {
  const [search, setSearch] = useState(""),
    [sort, setSort] = useState<SortOption>("newest"),
    [typeFilter, setTypeFilter] = useState<TypeFilter>("all"),
    [showDrafts, setShowDrafts] = useState(false),
    [targeting, setTargeting] = useState(false),
    navigate = useNavigate(),
    pg = useBrowserQueries(showDrafts),
    collectionNames = new Map<string, string>();
  for (const collection of pg.collections ?? []) {
    collectionNames.set(collection.id, collection.name);
  }
  // The per-dataset project chips: one membership read for every card —
  // dataset edges only (layer/app edges belong to their own
  // explorers' reads).
  const projectsByDataset = new Map<string, { id: string; title: string }[]>();
  for (const membership of pg.memberships ?? []) {
    if (membership.artifactKind !== "dataset") {
      continue;
    }
    const chips = projectsByDataset.get(membership.artifactId) ?? [];
    chips.push(membership.project);
    projectsByDataset.set(membership.artifactId, chips);
  }
  const allDatasets = withDrafts(pg.datasets, pg.drafts, showDrafts),
    visible = sortCatalogItems(
      filterCatalogItems(buildCatalogItems(allDatasets, pg.groups ?? []), search, typeFilter),
      sort,
    );

  if (pg.datasets === undefined || pg.groups === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const startFromHere = async (projectId: string): Promise<void> => {
    await navigate({ params: { projectId }, to: "/projects/$projectId/create" });
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        action={
          <Button
            onClick={() => {
              setTargeting(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            Create dataset
          </Button>
        }
        to="/datasets"
      />

      {allDatasets.length === 0 && (pg.groups ?? []).length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>No datasets yet</EmptyTitle>
            <EmptyDescription>
              Datasets are created inside projects — start here and pick (or name) the project.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => {
                setTargeting(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create your first dataset
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6 md:flex-row">
          <FiltersSidebar
            onShowDraftsChange={setShowDrafts}
            onSort={setSort}
            onTypeFilterChange={setTypeFilter}
            showDrafts={showDrafts}
            sort={sort}
            total={visible.length}
            typeFilter={typeFilter}
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
                {visible.map((item: CatalogItem) =>
                  item.kind === "group" ? (
                    <GroupCard
                      key={item.group.id}
                      collectionName={
                        item.group.collectionId === null
                          ? undefined
                          : collectionNames.get(item.group.collectionId)
                      }
                      item={item}
                    />
                  ) : (
                    <DatasetCard
                      key={item.dataset.id}
                      dataset={item.dataset}
                      projects={projectsByDataset.get(item.dataset.id)}
                      trailing={<DatasetCardAddToProjectButton datasetId={item.dataset.id} />}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <ProjectTargetSheet
        description="Creation happens inside projects — the dataset lands there as an owned draft."
        onOpenChange={setTargeting}
        onTarget={startFromHere}
        open={targeting}
        title="Create a dataset"
      />
    </main>
  );
}
