import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw, Unplug } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/errors";
import * as bindingsStore from "@/lib/store/bindings";
import type { BindingRow, SyncRunRow } from "@/lib/store/bindings";
import { isRemoteStale, isSyncStale } from "@/lib/store/bindings";
import { getSource } from "@/lib/store/sources";

/** The stale window the server revives runs past (bindings.ts/binding_stale_run_interval parity) — past it the card offers Resume. */
const STALE_RUN_MS = 2 * 60 * 1000;

function isRunActive(run: SyncRunRow): boolean {
  return run.status === "collecting" || run.status === "applying" || run.status === "sweeping";
}

function isRunQuiet(run: SyncRunRow): boolean {
  return Date.now() - Date.parse(run.lastProgressAt) > STALE_RUN_MS;
}

/** The one badge that summarizes the binding's sync state. */
function SyncBadge({
  binding,
  latestRemoteRevision,
}: {
  binding: BindingRow;
  latestRemoteRevision: number | undefined;
}) {
  let source: BoundSourceTransport | undefined;
  try {
    source = getSource(binding.source).transport;
  } catch {
    source = undefined;
  }
  if (source === "http") {
    if (isRemoteStale(binding, latestRemoteRevision)) {
      return <Badge variant="destructive">Update available</Badge>;
    }
    if (binding.remoteRevision === null) {
      return <Badge variant="secondary">Not synced</Badge>;
    }
    return <Badge variant="outline">Up to date</Badge>;
  }
  if (isSyncStale(binding)) {
    return <Badge variant="secondary">Source changed</Badge>;
  }
  return <Badge variant="outline">Up to date</Badge>;
}

type BoundSourceTransport = "http" | "client";

/**
 * The bound dataset's sync card (docs/bound-datasets-design.md §9's
 * dashboard sync card, mounted on the PG dataset page — issue #206's
 * "sync card" surface, the client-half edition): the binding's state, the
 * active run's live progress, Sync/Reconcile/Check controls, the keep-N
 * retention knob, and the creator-only unbind exit. The engine runs HERE
 * (store/bindings.ts drives the definer RPCs from the browser), so Sync now
 * awaits the whole pass; the run rows carry the progress for a refresh.
 */
// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup (the Convex SourceRow carries the same note).
function PgBindingCardBody({ binding, isCreator }: { binding: BindingRow; isCreator: boolean }) {
  const queryClient = useQueryClient();
  let transport: BoundSourceTransport | undefined;
  try {
    transport = getSource(binding.source).transport;
  } catch {
    transport = undefined;
  }
  const isRemote = transport === "http",
    remoteStatus = useQuery({
      ...bindingsStore.remoteSourceQueryOptions({ source: binding.source }),
      enabled: isRemote,
    }),
    runQuery = useQuery(bindingsStore.latestRunQueryOptions({ bindingId: binding.id })),
    // `undefined` (still loading) reads the same as "no run yet" — the
    // Convex sync card's normalization.
    run: SyncRunRow | null = runQuery.data ?? null,
    [isStarting, setIsStarting] = useState<"check" | "reconcile" | "resume" | "sync" | undefined>(),
    [isUnbinding, setIsUnbinding] = useState(false),
    [keepVersions, setKeepVersions] = useState<string>(
      binding.keepVersions === null ? "" : String(binding.keepVersions),
    ),
    invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:bindings"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
    },
    kickoff = async (mode: "reconcile" | "sync") => {
      setIsStarting(mode);
      try {
        const result = await bindingsStore.runSync({ mode, source: binding.source });
        toast.success(
          result.alreadyRunning
            ? "A sync is already running — showing its progress."
            : mode === "reconcile"
              ? "Reconcile complete."
              : "Sync complete.",
        );
      } catch (error) {
        toast.error(errorMessage(error, "Sync failed."));
      } finally {
        setIsStarting(undefined);
        invalidate();
      }
    },
    resume = async () => {
      if (run === null) {
        return;
      }
      setIsStarting("resume");
      try {
        const claimed = await bindingsStore.resumeDueRun({ runId: run.id });
        toast.success(
          claimed ? "Scheduled sync finished." : "Nothing to resume — the run already settled.",
        );
      } catch (error) {
        toast.error(errorMessage(error, "Resume failed."));
      } finally {
        setIsStarting(undefined);
        invalidate();
      }
    },
    check = async () => {
      setIsStarting("check");
      try {
        await bindingsStore.checkRemoteSource({ source: binding.source });
        toast.success("Checked the source.");
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't reach the source — see the status line."));
      } finally {
        setIsStarting(undefined);
        invalidate();
      }
    },
    unbind = async () => {
      setIsUnbinding(true);
      try {
        await bindingsStore.unbind({ bindingId: binding.id });
        toast.success(
          "Unbound — the projection and its sync history are gone; the source is untouched.",
        );
        invalidate();
      } catch (error) {
        toast.error(errorMessage(error, "Unbind failed."));
      } finally {
        setIsUnbinding(false);
      }
    },
    saveRetention = async () => {
      const parsed = keepVersions.trim() === "" ? null : Number(keepVersions);
      try {
        const rows = await bindingsStore.setRetention({
          bindingId: binding.id,
          keepVersions: parsed === null || !Number.isInteger(parsed) || parsed <= 0 ? null : parsed,
        });
        if (rows === 0) {
          toast.error("Couldn't save retention — you may no longer edit this dataset.");
          return;
        }
        toast.success("Retention saved — it applies after every sync.");
        invalidate();
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't save retention."));
      }
    },
    // A quiet active run is a dead driver (its tab closed) — this client can
    // claim and finish it, which is exactly how the weekly cron's scheduled
    // work items land (the pg_cron decision in migration 0012).
    resumable = run !== null && isRunActive(run) && isRunQuiet(run),
    latestRemoteRevision =
      remoteStatus.data === null || remoteStatus.data === undefined
        ? undefined
        : revisionOfLayer(remoteStatus.data.layer);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Source sync</CardTitle>
        <CardDescription>
          This dataset is a read-only projection of the bound source{" "}
          <span className="font-mono text-xs">{binding.source}</span>. Editing rows is disabled —
          sync applies the source's commits, and the weekly schedule reconciles drift.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {binding.syncedEntryCount ?? 0} features · synced{" "}
            {binding.lastSyncedAt === null
              ? "never"
              : formatDistanceToNow(new Date(binding.lastSyncedAt), { addSuffix: true })}
            {binding.lastReconciledAt !== null &&
              ` · reconciled ${formatDistanceToNow(new Date(binding.lastReconciledAt), { addSuffix: true })}`}
          </p>
          <SyncBadge binding={binding} latestRemoteRevision={latestRemoteRevision} />
        </div>

        {remoteStatus.data !== null &&
          remoteStatus.data !== undefined &&
          remoteStatus.data.error !== null && (
            <p className="text-xs text-destructive">Last check failed: {remoteStatus.data.error}</p>
          )}

        {run !== null && isRunActive(run) && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {run.status === "collecting"
              ? "Reading source state…"
              : run.status === "sweeping"
                ? "Finishing the sync…"
                : `Applying changes — ${run.applied}/${run.total} rows`}
          </p>
        )}
        {run !== null && run.status === "failed" && (
          <p className="text-xs text-destructive">Last sync failed: {run.error}</p>
        )}
        {run !== null && run.status === "completed" && run.finishedAt !== null && (
          <p className="text-xs text-muted-foreground">
            Last run {run.mode === "reconcile" ? "reconciled" : "synced"}{" "}
            {formatDistanceToNow(new Date(run.finishedAt), { addSuffix: true })} — {run.added}{" "}
            added, {run.removed} removed, {run.updated} updated.
          </p>
        )}
        {run !== null && run.status === "completed" && run.needsReconcile === true && (
          <p className="text-xs text-amber-600">
            A commit touched a row the projection never saw — a full reconcile was scheduled to
            restore it.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={isStarting !== undefined || (run !== null && isRunActive(run))}
            onClick={() => {
              void kickoff("sync");
            }}
            size="sm"
          >
            {isStarting === "sync"
              ? "Starting…"
              : run !== null && isRunActive(run)
                ? "Syncing…"
                : "Sync now"}
          </Button>
          <Button
            disabled={isStarting !== undefined || (run !== null && isRunActive(run))}
            onClick={() => {
              void kickoff("reconcile");
            }}
            size="sm"
            variant="outline"
          >
            {isStarting === "reconcile" ? "Starting…" : "Reconcile"}
          </Button>
          {isRemote && (
            <Button
              disabled={isStarting !== undefined}
              onClick={() => {
                void check();
              }}
              size="sm"
              variant="outline"
            >
              {isStarting === "check" ? "Checking…" : "Check"}
            </Button>
          )}
          {resumable && (
            <Button
              disabled={isStarting !== undefined}
              onClick={() => {
                void resume();
              }}
              size="sm"
              variant="secondary"
            >
              {isStarting === "resume" ? "Resuming…" : "Resume scheduled sync"}
            </Button>
          )}
          {isCreator && (
            <Button
              disabled={isUnbinding}
              onClick={() => {
                void unbind();
              }}
              size="sm"
              variant="destructive"
            >
              <Unplug className="h-3.5 w-3.5 mr-1.5" />
              {isUnbinding ? "Unbinding…" : "Unbind"}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t pt-4">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="keep-versions">
              Keep last N frozen versions
            </Label>
            <Input
              className="w-40"
              id="keep-versions"
              inputMode="numeric"
              onChange={(event) => {
                setKeepVersions(event.target.value);
              }}
              placeholder="default (10)"
              value={keepVersions}
            />
          </div>
          <Button
            onClick={() => {
              void saveRetention();
            }}
            size="sm"
            variant="outline"
          >
            Save retention
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Applied after every sync (pins exempt). Leave empty for the default of 10.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** The last successful manifest read's revision, or undefined when the check row carries none. */
function revisionOfLayer(layer: unknown): number | undefined {
  if (layer === null || typeof layer !== "object") {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the manifest read arrives as shapeless jsonb; the typeof read below is the guard.
  const revision = (layer as Record<string, unknown>).revision;
  return typeof revision === "number" ? revision : undefined;
}

/**
 * The sync card the PG dataset page mounts for a bound dataset (never
 * rendered for an ordinary dataset — the page gates on the `source` marker).
 */
export function PgBindingCard({ datasetId, isCreator }: { datasetId: string; isCreator: boolean }) {
  const bindingQuery = useQuery(bindingsStore.bindingForDatasetQueryOptions({ datasetId }));
  if (bindingQuery.data === null || bindingQuery.data === undefined) {
    return null;
  }
  return <PgBindingCardBody binding={bindingQuery.data} isCreator={isCreator} />;
}
