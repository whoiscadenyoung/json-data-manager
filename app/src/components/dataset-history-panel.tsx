import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { api } from "#convex/_generated/api";

type Binding = NonNullable<FunctionReturnType<typeof api.bindings.getBySchema>>;
type Activity = FunctionReturnType<typeof api.bindings.history>[number];

const OP_LABELS = {
  add: "Added",
  remove: "Removed",
  update: "Updated",
} as const;

/**
 * History tab for a bound dataset: one entry per sync, with the diff the
 * sync computed against the previous projection (added/removed/updated
 * locations, field-level detail on updates). Per-sync granularity until the
 * design's commit-level feed lands (docs/bound-datasets-design.md phase 4).
 */
export function DatasetHistoryPanel({ binding }: { binding: Binding }) {
  const activity = useQuery(api.bindings.history, { bindingId: binding._id });

  if (activity === undefined) {
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync history</CardTitle>
        <CardDescription>
          What each sync of the connected source changed in this dataset.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No syncs recorded yet — history starts with the next sync.
          </p>
        ) : (
          activity.map((entry) => <HistoryEntry key={entry._id} entry={entry} />)
        )}
      </CardContent>
    </Card>
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
