import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Calendar, ChevronRight, Database, FolderOpen, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { RouterButton } from "#/components/router-button";
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
import { fieldCount, schemaType } from "#/lib/json-schema";
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

type DatasetSummary = FunctionReturnType<typeof api.schemas.list>[number];

function filterAndSort(
  datasets: DatasetSummary[],
  query: string,
  sort: SortOption,
): DatasetSummary[] {
  const normalized = query.trim().toLowerCase(),
    filtered = normalized
      ? datasets.filter(
          (d) =>
            d.title.toLowerCase().includes(normalized) ||
            d.description.toLowerCase().includes(normalized),
        )
      : datasets;

  return filtered.toSorted((a, b) => {
    if (sort === "title-asc") {
      return a.title.localeCompare(b.title);
    }
    return sort === "oldest"
      ? a._creationTime - b._creationTime
      : b._creationTime - a._creationTime;
  });
}

function FiltersSidebar({
  total,
  sort,
  onSort,
}: {
  total: number;
  sort: SortOption;
  onSort: (sort: SortOption) => void;
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
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Database className="h-3 w-3" />
              {schemaType(dataset.schema)}
            </span>
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

function DatasetsPage() {
  const datasets = useQuery(api.schemas.list),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState<SortOption>("newest"),
    visible = useMemo(
      () => (datasets ? filterAndSort(datasets, search, sort) : []),
      [datasets, search, sort],
    );

  if (datasets === undefined) {
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
          <p className="text-muted-foreground">Manage your JSON datasets and create data entries</p>
        </div>
        <RouterButton to="/datasets/create">
          <Plus className="h-4 w-4 mr-2" />
          Create dataset
        </RouterButton>
      </div>

      {datasets.length === 0 ? (
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
          <FiltersSidebar total={visible.length} sort={sort} onSort={setSort} />

          <div className="min-w-0 flex-1">
            <div className="relative mb-4">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
                placeholder="Search datasets…"
                className="h-10 pl-9 text-sm"
              />
            </div>

            {visible.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center rounded-lg border text-sm text-muted-foreground">
                No datasets match "{search}".
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {visible.map((dataset) => (
                  <DatasetCard key={dataset._id} dataset={dataset} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
