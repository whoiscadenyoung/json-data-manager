import { Badge } from "@caden/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { GitCommitHorizontal, RefreshCw } from "lucide-react";
import { useState } from "react";

import { DiffOverlayMap, type DiffPoint, type DiffPointStatus } from "#/features/versions";
import * as bindingsStore from "@/lib/store/bindings";
import type { ActivityRow, BindingRow, CommitMirrorRow } from "@/lib/store/bindings";

const OP_LABELS = {
  add: "Added",
  remove: "Removed",
  update: "Updated",
} as const;

const COMMIT_OP_LABELS = {
  add: "Added",
  delete: "Removed",
  update: "Modified",
} as const;

interface CommitOpRecord {
  entryKey: string;
  fields?: Array<{ after?: unknown; before?: unknown; name: string }>;
  geometryChanged?: boolean;
  op: "add" | "delete" | "update";
}

/** The commit's ops as the structural view the rail's panel reads (mirror rows store the feed's ops verbatim, shapeless past that). */
function commitOpsOf(commit: CommitMirrorRow): CommitOpRecord[] {
  if (!Array.isArray(commit.ops)) {
    return [];
  }
  return commit.ops.filter((op): op is CommitOpRecord => {
    if (typeof op !== "object" || op === null) {
      return false;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mirror ops arrive as shapeless jsonb; the structural reads below are the guard.
    const record = op as Record<string, unknown>;
    return typeof record.entryKey === "string" && typeof record.op === "string";
  });
}

interface ActivityOpRecord {
  detail?: string;
  label: string;
  op: "add" | "remove" | "update";
}

/** The activity row's capped ops, structurally. */
function activityOpsOf(row: ActivityRow): ActivityOpRecord[] {
  if (!Array.isArray(row.ops)) {
    return [];
  }
  return row.ops.filter(
    (op): op is ActivityOpRecord =>
      typeof op === "object" &&
      op !== null &&
      typeof (op as Record<string, unknown>).label === "string",
  );
}

/** The one field-level before→after line (the History-tab detail format). */
function FieldDiff({ field }: { field: { after?: unknown; before?: unknown; name: string } }) {
  const before = JSON.stringify(field.before) ?? "null",
    after = JSON.stringify(field.after) ?? "null";
  if (before === after) {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-mono">{field.name}</span>: {before} → {after}
    </p>
  );
}

/**
 * The History tab of a bound PG dataset (docs/bound-datasets-design.md §7,
 * issue #206's "History tab" surface — the PG edition of the Convex
 * DatasetHistoryPanel): a commit rail (the applied-commit mirror, git-log
 * style — selecting one highlights its affected features on the dedicated
 * GeoJSON overlay, never the tile source) beside the field-level
 * before/after panel, plus the per-sync summary list (dataset_activity).
 */
// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup (the Convex DatasetHistoryPanel carries the same note).
export function PgBindingHistory({
  binding,
  isGeospatial,
}: {
  binding: BindingRow;
  isGeospatial: boolean;
}) {
  const commitsQuery = useQuery(bindingsStore.commitsQueryOptions({ bindingId: binding.id })),
    activityQuery = useQuery(bindingsStore.historyQueryOptions({ bindingId: binding.id })),
    featuresQuery = useQuery(
      bindingsStore.featuresForBindingQueryOptions({ bindingId: binding.id }),
    ),
    [selectedCommitId, setSelectedCommitId] = useState<string | undefined>();

  const commits = commitsQuery.data ?? [],
    selected =
      commitsQuery.data === undefined
        ? undefined
        : commitsQuery.data.find((commit) => commit.id === selectedCommitId);

  // Commit ops name entries by foreign key; the feature map resolves each
  // key to its current projected position (deletes are listed, not drawn —
  // the overlay's own rule).
  let selectedPoints: DiffPoint[] | undefined;
  if (selected !== undefined && featuresQuery.data !== undefined) {
    const features = featuresQuery.data;
    selectedPoints = commitOpsOf(selected).flatMap((op) => {
      const status: DiffPointStatus =
        op.op === "add" ? "add" : op.op === "delete" ? "delete" : "update";
      if (status === "delete") {
        return [];
      }
      const feature = features.find((candidate) => candidate.entryKey === op.entryKey);
      if (feature === undefined) {
        return [];
      }
      const lat = feature.data.lat,
        lng = feature.data.lng;
      if (typeof lat !== "number" || typeof lng !== "number") {
        return [];
      }
      return [{ key: op.entryKey, label: labelOf(feature.data, op.entryKey), lat, lng, status }];
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitCommitHorizontal className="h-5 w-5" />
            Applied commits
          </CardTitle>
          <CardDescription>
            The foreign commit tail this projection has applied, newest first. Selecting a commit
            highlights what it changed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {commits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No commits applied yet — sync to pull the source's tail.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col gap-1">
                {commits.map((commit) => {
                  const isSelected = commit.id === selectedCommitId;
                  return (
                    <button
                      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm ${
                        isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                      }`}
                      key={commit.id}
                      onClick={() => {
                        setSelectedCommitId(isSelected ? undefined : commit.id);
                      }}
                      type="button"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono text-xs text-muted-foreground">
                          {commit.foreignCommitId}
                        </span>{" "}
                        {commit.message}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(commit.at), { addSuffix: true })}
                      </span>
                    </button>
                  );
                })}
              </div>

              {selected !== undefined && (
                <div className={isGeospatial ? "grid gap-4 md:grid-cols-2" : "space-y-2"}>
                  {isGeospatial && selectedPoints !== undefined && selectedPoints.length > 0 && (
                    <div className="min-h-64 overflow-hidden rounded-md border">
                      <DiffOverlayMap points={selectedPoints} />
                    </div>
                  )}
                  <div className="space-y-2">
                    {commitOpsOf(selected).map((op) => (
                      <div className="rounded-md border p-2" key={`${op.entryKey}:${op.op}`}>
                        <p className="flex items-center gap-2 text-sm">
                          <Badge
                            variant={
                              op.op === "add"
                                ? "secondary"
                                : op.op === "delete"
                                  ? "destructive"
                                  : "outline"
                            }
                          >
                            {COMMIT_OP_LABELS[op.op]}
                          </Badge>
                          <span className="truncate font-mono text-xs">{op.entryKey}</span>
                        </p>
                        {(op.fields ?? []).map((field) => (
                          <FieldDiff field={field} key={field.name} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Sync history
          </CardTitle>
          <CardDescription>One summary per sync or reconcile pass, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {activityQuery.data === undefined ? (
            <div className="flex justify-center items-center min-h-20">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : activityQuery.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No syncs recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {activityQuery.data.map((row) => (
                <div className="rounded-md border p-3" key={row.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {row.kind === "reconcile" ? "Reconcile" : "Sync"}{" "}
                      <span className="font-normal text-muted-foreground">
                        {formatDistanceToNow(new Date(row.syncedAt), { addSuffix: true })}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {OP_LABELS.add} {row.added} · {OP_LABELS.update} {row.updated} ·{" "}
                      {OP_LABELS.remove} {row.removed} · {row.entryCount} features
                    </p>
                  </div>
                  {row.needsReconcile === true && (
                    <p className="mt-1 text-xs text-amber-600">
                      A commit touched a row the projection never saw — a full reconcile was
                      scheduled to restore it.
                    </p>
                  )}
                  {row.truncated === true && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      This pass touched more rows than the log keeps — the summary above is
                      complete, the per-row list is truncated.
                    </p>
                  )}
                  {activityOpsOf(row).length > 0 && (
                    <div className="mt-2 space-y-0.5">
                      {activityOpsOf(row).map((op) => (
                        <p className="text-xs text-muted-foreground" key={`${op.op}-${op.label}`}>
                          <span
                            className={
                              op.op === "add"
                                ? "text-green-600"
                                : op.op === "remove"
                                  ? "text-red-600"
                                  : "text-amber-600"
                            }
                          >
                            {OP_LABELS[op.op]}
                          </span>{" "}
                          {op.label}
                          {op.detail !== undefined && ` — ${op.detail}`}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The projected row's label (label, then name, then the key — the engine's rowLabel). */
function labelOf(data: Record<string, unknown>, key: string): string {
  const label = data.label;
  if (typeof label === "string" && label !== "") {
    return label;
  }
  const name = data.name;
  if (typeof name === "string" && name !== "") {
    return name;
  }
  return key;
}
