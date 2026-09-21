import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDistanceToNow } from "date-fns";
import { GitCommitHorizontal, RefreshCw } from "lucide-react";
import { useState } from "react";

import {
  DiffOverlayMap,
  type DiffPoint,
  type DiffPointStatus,
} from "#/components/diff-overlay-map";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { api } from "#convex/_generated/api";

type Binding = NonNullable<FunctionReturnType<typeof api.bindings.getBySchema>>;
type Activity = FunctionReturnType<typeof api.bindings.history>[number];
type Commit = FunctionReturnType<typeof api.sync.listCommits>[number];

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

/**
 * The History tab (docs/bound-datasets-design.md §7): a commit rail — the
 * applied foreign commit log, git-log style — plus the per-sync summary
 * list. Selecting a commit highlights its affected features on a dedicated
 * GeoJSON overlay (never the tile source) beside a field-level before/after
 * panel.
 */
// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
export function DatasetHistoryPanel({ binding }: { binding: Binding }) {
  const commits = useQuery(api.sync.listCommits, { bindingId: binding._id }),
    features = useQuery(api.sync.commitFeatureMap, { bindingId: binding._id }),
    activity = useQuery(api.bindings.history, { bindingId: binding._id }),
    [selectedCommitId, setSelectedCommitId] = useState<string | undefined>();

  // Commit ops name entries by foreign key; the feature map resolves each
  // key to its current projected position (the design's "current position"
  // rule — deletes are listed in the panel, not drawn).
  const selected =
    commits === undefined ? undefined : commits.find((commit) => commit._id === selectedCommitId);
  let selectedPoints: DiffPoint[] | undefined;
  if (selected !== undefined && features !== undefined) {
    const featureMap = features;
    selectedPoints = selected.ops.flatMap((op) => {
      const status: DiffPointStatus =
        op.op === "add" ? "add" : op.op === "delete" ? "delete" : "update";
      if (status === "delete") {
        return [];
      }
      const feature = featureMap.find((candidate) => candidate.entryKey === op.entryKey);
      if (feature === undefined) {
        return [];
      }
      const lat = feature.data.lat,
        lng = feature.data.lng;
      if (typeof lat !== "number" || typeof lng !== "number") {
        return [];
      }
      return [
        {
          key: op.entryKey,
          label: feature.label,
          lat,
          lng,
          status,
        },
      ];
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Commit history</CardTitle>
          <CardDescription>
            The source's applied commits, newest first — the foreign app's git log for this dataset.
            Select one to see exactly what it changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {commits === undefined ? (
            <p className="text-sm text-muted-foreground">Loading commits…</p>
          ) : commits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No commits applied yet — edits made on the dashboard since the last full sync will
              appear here after the next sync.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {commits.map((commit) => (
                <CommitRow
                  isSelected={commit._id === selectedCommitId}
                  key={commit._id}
                  onSelect={() => {
                    setSelectedCommitId((current) =>
                      current === commit._id ? undefined : commit._id,
                    );
                  }}
                  commit={commit}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected !== undefined && features !== undefined && selectedPoints !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitCommitHorizontal className="h-5 w-5" />
              {selected.message}
            </CardTitle>
            <CardDescription>
              {selected.foreignCommitId} · applied{" "}
              {formatDistanceToNow(new Date(selected.appliedAt), { addSuffix: true })}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            <DiffOverlayMap points={selectedPoints} />
            <ul className="flex flex-col gap-2">
              {selected.ops.map((op) => (
                <li className="rounded-md border px-3 py-2" key={`${op.op}-${op.entryKey}`}>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        op.op === "add"
                          ? "default"
                          : op.op === "delete"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {COMMIT_OP_LABELS[op.op]}
                    </Badge>
                    <span className="text-sm">{labelFor(features, op.entryKey)}</span>
                  </div>
                  {op.fields.length > 0 && (
                    <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                      {op.fields.map((field) => (
                        <li key={field.name}>
                          {field.name}: {JSON.stringify(field.before)} →{" "}
                          {JSON.stringify(field.after)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Sync runs</CardTitle>
          <CardDescription>
            The full syncs and reconciles that carry the commit tail — one entry per run.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {activity === undefined ? (
            <p className="text-sm text-muted-foreground">Loading history…</p>
          ) : activity.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No syncs recorded yet — history starts with the next sync.
            </p>
          ) : (
            activity.map((entry) => <HistoryEntry key={entry._id} entry={entry} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function labelFor(features: Array<{ entryKey: string; label: string }>, entryKey: string): string {
  const match = features.find((candidate) => candidate.entryKey === entryKey);
  return match !== undefined ? match.label : entryKey;
}

function CommitRow({
  commit,
  isSelected,
  onSelect,
}: {
  commit: Commit;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const added = commit.ops.filter((op) => op.op === "add").length,
    removed = commit.ops.filter((op) => op.op === "delete").length,
    updated = commit.ops.filter((op) => op.op === "update").length;
  return (
    <li>
      <button
        type="button"
        className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left ${
          isSelected ? "border-primary bg-primary/5" : ""
        }`}
        onClick={onSelect}
      >
        <span className="flex min-w-0 items-center gap-2">
          <GitCommitHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{commit.message}</span>
            <span className="block truncate text-xs text-muted-foreground">
              #{commit.seq} · {formatDistanceToNow(new Date(commit.appliedAt), { addSuffix: true })}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {added > 0 && <Badge variant="default">+{added}</Badge>}
          {removed > 0 && <Badge variant="destructive">−{removed}</Badge>}
          {updated > 0 && <Badge variant="secondary">~{updated}</Badge>}
        </span>
      </button>
    </li>
  );
}

function HistoryEntry({ entry }: { entry: Activity }) {
  const touched = entry.added + entry.removed + entry.updated;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
          {entry.kind === "reconcile" ? "Reconciled" : "Synced"}{" "}
          {formatDistanceToNow(new Date(entry.syncedAt), { addSuffix: true })}
          <span className="text-xs font-normal text-muted-foreground">
            {new Date(entry.syncedAt).toLocaleString()}
          </span>
          {entry.kind === "reconcile" && <Badge variant="outline">Full reconcile</Badge>}
        </div>
        <div className="flex items-center gap-1.5">
          {touched === 0 && <Badge variant="outline">No changes</Badge>}
          {entry.added > 0 && <Badge variant="default">+{entry.added} added</Badge>}
          {entry.removed > 0 && <Badge variant="destructive">−{entry.removed} removed</Badge>}
          {entry.updated > 0 && <Badge variant="secondary">~{entry.updated} updated</Badge>}
        </div>
      </div>
      {entry.ops.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {entry.ops.map((op) => (
            <li className="flex flex-col gap-0.5" key={`${op.op}-${op.label}`}>
              <span className="text-sm">
                <Badge
                  className="mr-2"
                  variant={
                    op.op === "add" ? "default" : op.op === "remove" ? "destructive" : "secondary"
                  }
                >
                  {OP_LABELS[op.op]}
                </Badge>
                {op.label}
              </span>
              {op.detail && (
                <span className="pl-1 font-mono text-xs text-muted-foreground">{op.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {entry.truncated && (
        <p className="text-xs text-muted-foreground">
          Some further changes were truncated from this entry.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {entry.entryCount} features in the projection after this sync.
      </p>
    </div>
  );
}
