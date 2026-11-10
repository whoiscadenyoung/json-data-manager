import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card } from "@caden/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Workflow } from "lucide-react";
import { useState } from "react";

import { latestRunsQueryOptions, listViewSummariesQueryOptions } from "@/lib/store/view-reads";
import type { ViewLatestRun, ViewSummary } from "@/lib/store/view-reads";

import { relativeTime } from "../lib/format";
import { CreateViewSheet } from "./create-view-sheet";

const VIEWER_REASON = "You have read-only access to this project.";

/** One catalog card: refresh mode, last run, a stale or error badge and the input count. */
export function ViewCard({
  inputTitles,
  lastRun,
  projectId,
  view,
}: {
  inputTitles: string[];
  lastRun: ViewLatestRun | undefined;
  projectId: string;
  view: ViewSummary;
}) {
  const failed = lastRun !== undefined && lastRun.status === "error",
    inputCount = view.inputs.length;
  return (
    <Card className="flex-row items-center gap-4 px-4 py-3 transition-shadow hover:shadow-md">
      <Link
        className="flex min-w-0 flex-1 flex-col gap-1.5 py-0"
        params={{ projectId, viewId: view.id }}
        to="/projects/$projectId/views/$viewId"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            <Workflow className="h-3 w-3" />
            View
          </Badge>
          <Badge title="How this view's rows are refreshed." variant="outline">
            {view.refreshMode ?? "manual"}
          </Badge>
          {failed ? (
            <Badge title={lastRun.error ?? "The last run failed."} variant="destructive">
              Error
            </Badge>
          ) : view.stale ? (
            <Badge
              title="Inputs or steps changed since the last successful run."
              variant="secondary"
            >
              Stale
            </Badge>
          ) : null}
          {view.lifecycle === "draft" && <Badge variant="secondary">Draft</Badge>}
        </div>
        <p className="truncate text-sm font-medium">{view.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {lastRun === undefined ? "Never run" : `Last run ${relativeTime(lastRun.finishedAt)}`}
          {" · "}
          {inputCount} {inputCount === 1 ? "input" : "inputs"}
          {inputTitles.length > 0 ? ` (${inputTitles.join(", ")})` : ""}
          {view.entryCount > 0 ? ` · ${view.entryCount.toLocaleString()} rows` : ""}
        </p>
      </Link>
    </Card>
  );
}

/**
 * The catalog's Views section: the project's views as cards plus "New view".
 * "Create view from relation" lives in the Relations section next to the
 * relation it pre-fills from.
 */
export function ProjectViewsSection({
  canEdit,
  datasets,
  projectId,
}: {
  canEdit: boolean;
  /** Every dataset membership of the project by id, with its title and kind. */
  datasets: { id: string; kind: "source" | "view"; title: string }[];
  projectId: string;
}) {
  const [createOpen, setCreateOpen] = useState(false),
    summaries = useQuery(listViewSummariesQueryOptions()),
    memberIds = new Set(datasets.map((dataset) => dataset.id)),
    views = (summaries.data ?? []).filter((view) => memberIds.has(view.id)),
    titleById = new globalThis.Map(datasets.map((dataset) => [dataset.id, dataset.title])),
    runs = useQuery(latestRunsQueryOptions(views.map((view) => view.id))).data;
  return (
    <section aria-label="Views">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Views{" "}
          <span className="font-normal">
            ({views.length} {views.length === 1 ? "view" : "views"})
          </span>
        </h2>
        <Button
          disabled={!canEdit}
          onClick={() => {
            setCreateOpen(true);
          }}
          size="sm"
          title={canEdit ? "Build a dataset from steps (join, filter, group)" : VIEWER_REASON}
          variant="outline"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          New view
        </Button>
      </div>
      {views.length === 0 ? (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          No views yet. A view joins, filters and summarizes datasets into a new one, and saves its
          rows when you run it.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {views.map((view) => (
            <ViewCard
              inputTitles={view.inputs.map(
                (input) => titleById.get(input.inputDatasetId) ?? "a dataset you can't see",
              )}
              key={view.id}
              lastRun={runs === undefined ? undefined : runs.get(view.id)}
              projectId={projectId}
              view={view}
            />
          ))}
        </div>
      )}
      <CreateViewSheet
        datasets={datasets.map((dataset) => ({ id: dataset.id, title: dataset.title }))}
        onOpenChange={setCreateOpen}
        open={createOpen}
        projectId={projectId}
      />
    </section>
  );
}
