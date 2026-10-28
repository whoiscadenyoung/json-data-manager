import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";

type RemoteStatus = NonNullable<FunctionReturnType<typeof api.sources.remoteSources.status>>;
type RunRow = NonNullable<FunctionReturnType<typeof api.sources.sync.latestRun>>;

function isRunActive(run: RunRow | null | undefined): boolean {
  return (
    run !== null &&
    run !== undefined &&
    (run.status === "collecting" || run.status === "applying" || run.status === "sweeping")
  );
}

/** The one badge that summarizes a remote layer's state. */
function RemoteStatusBadge({ status }: { status: RemoteStatus }) {
  if (status.schemaChanged) {
    return <Badge variant="destructive">Source schema changed</Badge>;
  }
  if (status.syncedRevision === undefined) {
    return <Badge variant="secondary">Not synced</Badge>;
  }
  if (status.outOfDate) {
    return <Badge variant="destructive">Update available</Badge>;
  }
  return <Badge variant="outline">Up to date</Badge>;
}

function revisionText(status: RemoteStatus): string {
  const synced =
    status.syncedRevision === undefined ? "never synced" : `synced rev ${status.syncedRevision}`;
  const latest =
    status.latest === undefined
      ? "source not checked yet"
      : `source at rev ${status.latest.revision}`;
  const checked =
    status.checkedAt === undefined
      ? ""
      : ` · checked ${formatDistanceToNow(new Date(status.checkedAt), { addSuffix: true })}`;
  return `${synced} · ${latest}${checked}`;
}

function RunLine({ run }: { run: RunRow | null | undefined }) {
  if (run === null || run === undefined) {
    return null;
  }
  if (isRunActive(run)) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCw className="h-3 w-3 animate-spin" />
        {run.status === "collecting"
          ? "Reading the remote layer…"
          : run.status === "sweeping"
            ? "Finishing the sync…"
            : `Applying changes — ${run.applied}/${run.total} rows`}
      </p>
    );
  }
  if (run.status === "failed") {
    return <p className="text-xs text-destructive">Last sync failed: {run.error}</p>;
  }
  return null;
}

/**
 * Status + Check/Sync for one remote bound source (#78,
 * docs/remote-source-adapter-design.md §5). Renders nothing for local
 * sources. Mounting refreshes the manifest check when it's older than a
 * minute (server-throttled), so an open page shows "Update available" without
 * waiting for the cron.
 */
export function RemoteSourceControls({ source }: { source: string }) {
  const status = useQuery(api.sources.remoteSources.status, { source }),
    run = useQuery(api.sources.sync.latestRun, { source }),
    checkIfStale = useAction(api.sources.remoteSources.checkIfStale),
    check = useAction(api.sources.remoteSources.check),
    sync = useAction(api.sources.remoteSources.sync),
    [pending, setPending] = useState<"check" | "sync" | undefined>(),
    isRemote = status !== null && status !== undefined;

  useEffect(() => {
    if (isRemote) {
      checkIfStale({ source }).catch(() => {
        // The check records its own error on the status row.
      });
    }
  }, [checkIfStale, isRemote, source]);

  if (!isRemote) {
    return null;
  }

  const runActive = isRunActive(run),
    onCheck = async () => {
      setPending("check");
      try {
        const result = await check({ source });
        if (result.ok) {
          toast.success("Checked the source.");
        } else {
          toast.error("Couldn't reach the source — see the status line.");
        }
      } finally {
        setPending(undefined);
      }
    },
    onSync = async () => {
      setPending("sync");
      try {
        const result = await sync({ source });
        toast.success(
          result.alreadyRunning
            ? "A sync is already running — showing its progress."
            : "Sync started.",
        );
      } catch (error) {
        toast.error(errorMessage(error, "Sync failed to start."));
      } finally {
        setPending(undefined);
      }
    };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <RemoteStatusBadge status={status} />
        <span>{revisionText(status)}</span>
      </div>
      {status.checkError !== undefined && (
        <p className="text-xs text-destructive">Last check failed: {status.checkError}</p>
      )}
      <RunLine run={run} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending !== undefined || runActive || status.schemaChanged}
          onClick={() => {
            void onSync();
          }}
        >
          {pending === "sync" ? "Starting…" : runActive ? "Syncing…" : "Sync"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending !== undefined}
          onClick={() => {
            void onCheck();
          }}
        >
          {pending === "check" ? "Checking…" : "Check"}
        </Button>
      </div>
    </div>
  );
}
