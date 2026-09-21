import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { isSyncStale } from "#/lib/sync-staleness";
import { api } from "#convex/_generated/api";

type BindingRow = FunctionReturnType<typeof api.bindings.list>[number];

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * One bound source: its projection's sync state, a live progress row for the
 * active run, and the Sync / Reconcile controls. The durable engine runs
 * server-side (sync.ts) — the buttons only kick it off, and the row
 * subscribes to the run's progress until it settles.
 */
function SourceRow({ binding }: { binding: BindingRow }) {
  const run = useQuery(api.sync.latestRun, { source: binding.source }),
    startRun = useMutation(api.sync.startRun),
    [isStarting, setIsStarting] = useState<"reconcile" | "sync" | undefined>(),
    kickoff = async (mode: "reconcile" | "sync") => {
      setIsStarting(mode);
      try {
        const result = await startRun({ mode, source: binding.source });
        toast.success(
          result.alreadyRunning
            ? "A sync is already running — showing its progress."
            : mode === "reconcile"
              ? "Reconcile started."
              : "Sync started.",
        );
      } catch (error) {
        toast.error(errorMessage(error, "Sync failed to start."));
      } finally {
        setIsStarting(undefined);
      }
    },
    // `undefined` (still loading) reads the same as "no run yet".
    lastRun = run ?? null,
    isActive =
      lastRun !== null && (lastRun.status === "applying" || lastRun.status === "collecting"),
    isStale = isSyncStale(binding);

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{binding.datasetTitle}</p>
          <p className="truncate text-xs text-muted-foreground">
            {binding.source} · {binding.syncedEntryCount ?? 0} features · synced{" "}
            {binding.lastSyncedAt === undefined
              ? "never"
              : formatDistanceToNow(new Date(binding.lastSyncedAt), { addSuffix: true })}
            {binding.lastReconciledAt !== undefined &&
              ` · reconciled ${formatDistanceToNow(new Date(binding.lastReconciledAt), { addSuffix: true })}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {!binding.datasetExists ? (
            <Badge variant="destructive">Missing dataset</Badge>
          ) : isStale ? (
            <Badge variant="secondary">Source changed</Badge>
          ) : (
            <Badge variant="outline">Up to date</Badge>
          )}
        </div>
      </div>
      {lastRun !== null && isActive && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" />
          {lastRun.status === "collecting"
            ? "Reading source state…"
            : `Applying changes — ${lastRun.applied}/${lastRun.total} rows`}
        </p>
      )}
      {lastRun !== null && lastRun.status === "failed" && (
        <p className="text-xs text-destructive">Last sync failed: {lastRun.error}</p>
      )}
      {lastRun !== null && lastRun.status === "completed" && lastRun.finishedAt !== undefined && (
        <p className="text-xs text-muted-foreground">
          Last run {lastRun.mode === "reconcile" ? "reconciled" : "synced"}{" "}
          {formatDistanceToNow(new Date(lastRun.finishedAt), { addSuffix: true })} — {lastRun.added}{" "}
          added, {lastRun.removed} removed, {lastRun.updated} updated.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={isStarting !== undefined || isActive}
          onClick={() => {
            void kickoff("sync");
          }}
        >
          {isStarting === "sync" ? "Starting…" : isActive ? "Syncing…" : "Sync now"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isStarting !== undefined || isActive}
          onClick={() => {
            void kickoff("reconcile");
          }}
        >
          {isStarting === "reconcile" ? "Starting…" : "Reconcile"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Every bound source's sync state and controls (docs/bound-datasets-design.md
 * §5). Editing the source tables never auto-propagates: each source write
 * stamps `sourceUpdatedAt`, the row flips to "Source changed", and "Sync
 * now" starts the durable engine. A weekly cron reconciles every binding;
 * "Reconcile" runs the same full diff-and-repair pass on demand.
 */
export function SyncStatusCard() {
  const bindings = useQuery(api.bindings.list),
    startRun = useMutation(api.sync.startRun),
    [isStarting, setIsStarting] = useState(false),
    createFirstDataset = async () => {
      setIsStarting(true);
      try {
        await startRun({ mode: "sync", source: "restaurantLocations" });
        toast.success("Sync started.");
      } catch (error) {
        toast.error(errorMessage(error, "Sync failed to start."));
      } finally {
        setIsStarting(false);
      }
    };

  if (bindings === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bound datasets</CardTitle>
          <CardDescription>Loading sync status…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (bindings.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bound datasets</CardTitle>
          <CardDescription>
            No projected datasets yet — the first sync creates the geospatial "Restaurant locations"
            dataset from the tables below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => {
              void createFirstDataset();
            }}
            disabled={isStarting}
          >
            {isStarting ? "Syncing…" : "Create dataset (sync now)"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bound datasets</CardTitle>
        <CardDescription>
          Read-only projections of the source tables, rendered by the maps and datasets browser.
          Syncs run durably server-side — interrupted runs resume from their checkpoint.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {bindings.map((binding) => (
          <SourceRow key={binding._id} binding={binding} />
        ))}
      </CardContent>
    </Card>
  );
}
