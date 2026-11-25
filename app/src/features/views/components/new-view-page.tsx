import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Database, Loader2, Search, Table2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "@/components/router-button";
import { ViewNodeGraph } from "@/features/view-graphs";
import { errorMessage } from "@/lib/errors";
import * as datasetsStore from "@/lib/store/datasets";
import * as projectsStore from "@/lib/store/projects";

import { createProjectView } from "../lib/create-view";
import { blankDefinitionOf } from "../lib/view-model";
import { ADD_ITEMS, AddNodeToolbar } from "./node-list";

/**
 * "New view" on the canvas (replaces the old sheet): a title, and the dataset
 * the view starts from, picked BY TITLE from the project's datasets and views.
 * The canvas shows the flow the view will open with (start, then output).
 * Both fields are required and the page says which is missing; Create never
 * sits silently disabled. Nodes are added in the editor, which opens right
 * after Create: a view only exists (and can only preview) once it has a base.
 */

interface BaseOption {
  id: string;
  kind: "source" | "view";
  title: string;
  entryCount: number;
}

/** What the canvas draws before a dataset is picked: a placeholder source flowing into the output. */
const PLACEHOLDER = blankDefinitionOf([{ datasetId: "", title: "start" }]);

const KIND_NOTES: Record<(typeof ADD_ITEMS)[number]["kind"], string> = {
  calculate: "Add fields from expressions over the others, such as cleaning text into numbers.",
  columns: "Rename many columns and drop the ones you don't need.",
  stack: "Stack nodes under each other (for example one per year).",
  filter: "Keep only the rows that meet your conditions.",
  groupBy: "One row per group, with counts, sums and averages.",
  join: "Match rows on a code or a name, with a key map for the ones that differ.",
  sql: "Write the query yourself when the others don't fit.",
};

function missingOf(title: string, picked: readonly BaseOption[]): string[] {
  return [
    ...(title.trim() === "" ? ["Give the view a title."] : []),
    ...(picked.length === 0 ? ["Pick at least one dataset for the view to read."] : []),
  ];
}

export function NewViewPage({ projectId }: { projectId: string }) {
  const [title, setTitle] = useState(""),
    [pickedIds, setPickedIds] = useState<string[]>([]),
    [startId, setStartId] = useState(""),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    navigate = useNavigate(),
    queryClient = useQueryClient(),
    catalogQuery = useQuery(projectsStore.listCatalogQueryOptions({ projectId })),
    datasetsQuery = useQuery(datasetsStore.listQueryOptions()),
    memberIds = new Set(
      (catalogQuery.data ?? [])
        .filter((row) => row.artifact.artifactKind === "dataset")
        .map((row) => row.artifact.artifactId),
    ),
    options: BaseOption[] = (datasetsQuery.data ?? [])
      .filter((dataset) => memberIds.has(dataset.id))
      .map((dataset) => ({
        entryCount: dataset.entryCount,
        id: dataset.id,
        kind: dataset.kind,
        title: dataset.title,
      }))
      // Datasets first, then views, each by title.
      .toSorted(
        (a, b) =>
          Number(a.kind === "view") - Number(b.kind === "view") || a.title.localeCompare(b.title),
      ),
    loading = catalogQuery.isPending || datasetsQuery.isPending,
    picked = pickedIds.flatMap((id) => options.filter((option) => option.id === id)),
    base = picked.find((option) => option.id === startId) ?? picked[0],
    missing = missingOf(title, picked),
    toggle = (id: string): void => {
      const next = pickedIds.includes(id)
        ? pickedIds.filter((entry) => entry !== id)
        : [...pickedIds, id];
      setPickedIds(next);
      if (!next.includes(startId)) {
        setStartId(next[0] ?? "");
      }
    },
    needle = search.trim().toLowerCase(),
    shown = options.filter((option) => option.title.toLowerCase().includes(needle));

  const previewDefinition =
    picked.length === 0
      ? PLACEHOLDER
      : blankDefinitionOf(
          picked.map((option) => ({ datasetId: option.id, title: option.title })),
          base === undefined ? undefined : base.id,
        );
  const previewTitles: Record<string, string> =
    picked.length === 0
      ? { start: "Pick a dataset" }
      : Object.fromEntries(
          Object.entries(previewDefinition.nodes).flatMap(([id, node]) => {
            const found =
              node.kind === "source" ? picked.find((o) => o.id === node.ref.id) : undefined;
            return found === undefined ? [] : [[id, found.title]];
          }),
        );

  const create = async (): Promise<void> => {
    if (base === undefined) {
      return;
    }
    setBusy(true);
    try {
      const viewId = await createProjectView({
        definition: blankDefinitionOf(
          picked.map((option) => ({ datasetId: option.id, title: option.title })),
          base.id,
        ),
        projectId,
        title: title.trim(),
      });
      void queryClient.invalidateQueries({ queryKey: ["views"] });
      void queryClient.invalidateQueries({ queryKey: ["datasets"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({ params: { projectId, viewId }, to: "/projects/$projectId/views/$viewId" });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't create the view."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-[110rem] px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            <Link params={{ projectId }} to="/projects/$projectId/catalog">
              Catalog
            </Link>{" "}
            / New view
          </p>
          <div className="flex max-w-md flex-col gap-1.5">
            <Label htmlFor="new-view-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-view-title"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              placeholder="e.g. Deployments per state"
              value={title}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <RouterButton params={{ projectId }} to="/projects/$projectId/catalog" variant="outline">
            Cancel
          </RouterButton>
          <Button
            disabled={missing.length > 0 || busy}
            onClick={() => {
              void create();
            }}
            type="button"
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create view
          </Button>
        </div>
      </header>
      {missing.length > 0 && (
        <ul className="mt-2 text-xs text-muted-foreground" data-testid="create-reasons">
          {missing.map((reason) => (
            <li key={reason}>Create view: {reason}</li>
          ))}
        </ul>
      )}

      <section aria-label="Nodes" className="relative mt-6">
        <ViewNodeGraph
          className="h-64"
          definition={previewDefinition}
          options={{
            describeNode: (id) => ({ label: previewTitles[id] ?? id }),
            outputDetail: "Every field, as named",
          }}
        />
        <AddNodeToolbar
          className="absolute top-3 left-3"
          disabledReason="Create the view first: nodes are added in the editor that opens next."
          onAdd={() => {}}
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <section aria-label="Node kinds" className="flex min-w-0 flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">What a view can do</h2>
            <p className="text-sm text-muted-foreground">
              A view is a graph of nodes: datasets flow through filters, joins, stacks and more into
              one result. Build the graph in the editor that opens after Create.
            </p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ADD_ITEMS.map((item) => (
              <li className="flex flex-col gap-1 rounded-lg border p-3" key={item.kind}>
                <item.icon className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground">{KIND_NOTES[item.kind]}</span>
              </li>
            ))}
          </ul>
        </section>

        <aside aria-label="Datasets to read" className="min-w-0">
          <Card className="flex flex-col gap-3 p-4">
            <div>
              <h2 className="text-sm font-medium">
                Datasets this view reads <span className="text-destructive">*</span>
              </h2>
              <p className="text-xs text-muted-foreground">
                Pick every dataset or view the view will use (you can add more later). The first is
                where it starts.
              </p>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Search datasets and views"
                className="pl-8"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                placeholder="Search datasets and views"
                type="search"
                value={search}
              />
            </div>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading the project's datasets…</p>
            ) : options.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This project has no datasets yet. Create or import one first.
              </p>
            ) : shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing matches “{search.trim()}”.</p>
            ) : (
              <fieldset className="flex max-h-96 min-w-0 flex-col gap-2 overflow-y-auto">
                <legend className="sr-only">Datasets</legend>
                {shown.map((option) => (
                  <label
                    className={
                      pickedIds.includes(option.id)
                        ? "flex cursor-pointer items-center gap-3 rounded-lg border border-primary bg-muted/40 px-3 py-2"
                        : "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 hover:bg-muted/40"
                    }
                    key={option.id}
                  >
                    <input
                      checked={pickedIds.includes(option.id)}
                      className="accent-primary"
                      name="new-view-inputs"
                      onChange={() => {
                        toggle(option.id);
                      }}
                      type="checkbox"
                      value={option.id}
                    />
                    {option.kind === "view" ? (
                      <Table2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{option.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {option.kind === "view" ? "View" : "Dataset"} ·{" "}
                        {option.entryCount.toLocaleString()} rows
                      </span>
                    </span>
                    {pickedIds.length > 1 && pickedIds.includes(option.id) && (
                      <button
                        className="ml-auto rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                        onClick={(event) => {
                          event.preventDefault();
                          setStartId(option.id);
                        }}
                        title="Make this the dataset the view starts from"
                        type="button"
                      >
                        {base !== undefined && base.id === option.id ? "Start" : "Make start"}
                      </button>
                    )}
                  </label>
                ))}
              </fieldset>
            )}
          </Card>
        </aside>
      </div>
    </main>
  );
}
