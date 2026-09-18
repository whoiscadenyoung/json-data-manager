import { useMutation, useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { api } from "#convex/_generated/api";

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

type SyncClocks = { lastSyncedAt?: number; sourceUpdatedAt?: number };

/** True when a source-table write landed after the last projection sync. */
function isBindingStale(binding: SyncClocks): boolean {
  return (
    binding.sourceUpdatedAt !== undefined &&
    (binding.lastSyncedAt === undefined || binding.sourceUpdatedAt > binding.lastSyncedAt)
  );
}

function formatLastSynced(binding: SyncClocks): string {
  return binding.lastSyncedAt === undefined
    ? "never"
    : formatDistanceToNow(new Date(binding.lastSyncedAt), { addSuffix: true });
}

/**
 * State of the bound dataset relative to the source tables below it — the
 * PoC's "live view" control. Editing the tables never auto-propagates: every
 * source write stamps `sourceUpdatedAt`, the card flips to "Source changed",
 * and "Sync now" rebuilds the projection (bindings.syncRestaurantLocations).
 */
export function SyncStatusCard() {
  const status = useQuery(api.bindings.status),
    sync = useMutation(api.bindings.syncRestaurantLocations),
    [isSyncing, setIsSyncing] = useState(false),
    handleSync = async () => {
      setIsSyncing(true);
      try {
        const result = await sync({});
        toast.success(`Dataset synced — ${result.entries} features.`);
      } catch (error) {
        toast.error(errorMessage(error, "Sync failed."));
      } finally {
        setIsSyncing(false);
      }
    };

  if (status === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bound dataset</CardTitle>
          <CardDescription>Loading sync status…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (status === null || status.schema === null) {
    // No binding yet, or the bound dataset was deleted out from under the
    // binding — either way, the next sync recreates the dataset.
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bound dataset</CardTitle>
          <CardDescription>
            {status === null
              ? 'No projected dataset yet — the first sync creates the geospatial "Restaurant locations" dataset from the tables below.'
              : "The bound dataset no longer exists — sync to recreate it from the tables below."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => {
              void handleSync();
            }}
            disabled={isSyncing}
          >
            {isSyncing ? "Syncing…" : "Create dataset (sync now)"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { binding, schema } = status,
    isStale = isBindingStale(binding),
    lastSynced = formatLastSynced(binding);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{schema.title}</CardTitle>
          {isStale ? (
            <Badge variant="secondary">Source changed</Badge>
          ) : (
            <Badge variant="outline">Up to date</Badge>
          )}
        </div>
        <CardDescription>
          Read-only projection of the tables below, rendered by the maps and datasets browser.{" "}
          {binding.syncedEntryCount} features · synced {lastSynced}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          onClick={() => {
            void handleSync();
          }}
          disabled={isSyncing}
        >
          {isSyncing ? "Syncing…" : "Sync now"}
        </Button>
      </CardContent>
    </Card>
  );
}
