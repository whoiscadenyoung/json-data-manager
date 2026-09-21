import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDistanceToNow } from "date-fns";
import { Camera, CloudDownload, Tag } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { api } from "#convex/_generated/api";

type Snapshot = FunctionReturnType<typeof api.tags.listSnapshots>[number];
type Version = FunctionReturnType<typeof api.tags.listVersions>[number];

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
 * The foreign app's snapshot timeline and the ingest that mirrors it into
 * json-cms (bound-datasets-design.md §6): "Take snapshot" serializes the
 * source tables to a snapshot file (the foreign app's push), "Ingest
 * missing" is the pull reconcile that freezes every not-yet-ingested
 * snapshot into a read-only version dataset via the import pipeline.
 * Ingest is idempotent — already-frozen refs are skipped — so the button is
 * safe to mash.
 */
export function SnapshotsCard() {
  const status = useQuery(api.bindings.status);

  if (status === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Snapshots</CardTitle>
          <CardDescription>Loading snapshot timeline…</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (status === null || status.schema === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Snapshots</CardTitle>
          <CardDescription>
            No bound dataset yet — sync once (card above) so snapshots have a live dataset to freeze
            against.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <SnapshotsPanel liveSchemaId={status.schema._id} />;
}

/**
 * The card once a live dataset exists: the snapshot timeline, the create
 * form, and the ingest button with its pending count.
 */
function SnapshotsPanel({ liveSchemaId }: { liveSchemaId: string }) {
  const snapshots = useQuery(api.tags.listSnapshots),
    versions = useQuery(api.tags.listVersions, { sourceSchemaId: liveSchemaId }),
    createSnapshot = useAction(api.tags.createRestaurantSnapshot),
    ingest = useAction(api.tags.ingestSnapshots),
    [label, setLabel] = useState(""),
    [isBusy, setIsBusy] = useState(false),
    suggestedLabel = snapshots === undefined ? "" : `v${snapshots.length + 1}`,
    ingestedByRef = indexVersionsByRef(versions),
    pendingCount = (snapshots ?? []).filter((snapshot) => !ingestedByRef.has(snapshot.ref)).length,
    handleCreate = async () => {
      setIsBusy(true);
      try {
        const result = await createSnapshot({
          label: label.trim() === "" ? suggestedLabel : label.trim(),
        });
        toast.success(`Snapshot "${result.label}" taken — ${result.rowCount} rows.`);
        setLabel("");
      } catch (error) {
        toast.error(errorMessage(error, "Snapshot failed."));
      } finally {
        setIsBusy(false);
      }
    },
    handleIngest = async () => {
      setIsBusy(true);
      try {
        const result = await ingest({});
        reportIngest(result.ingested.length, result.failed);
      } catch (error) {
        toast.error(errorMessage(error, "Ingest failed."));
      } finally {
        setIsBusy(false);
      }
    };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          Snapshots
          {snapshots !== undefined && pendingCount > 0 && (
            <Badge variant="secondary">{pendingCount} not ingested</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Point-in-time captures of the source tables. Ingesting freezes each one into a read-only
          version dataset — visible on the live dataset's page and layerable in maps.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
            placeholder={suggestedLabel}
            className="w-40"
            aria-label="Snapshot label"
          />
          <Button onClick={() => void handleCreate()} disabled={isBusy}>
            <Camera className="h-4 w-4 mr-2" />
            Take snapshot
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleIngest()}
            disabled={isBusy || pendingCount === 0}
          >
            <CloudDownload className="h-4 w-4 mr-2" />
            {isBusy ? "Ingesting…" : `Ingest missing (${pendingCount})`}
          </Button>
        </div>
        {snapshots === undefined ? null : snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No snapshots yet — take one to capture the current state of the tables.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {snapshots.map((snapshot) => (
              <SnapshotRow
                key={snapshot.ref}
                snapshot={snapshot}
                version={ingestedByRef.get(snapshot.ref)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function indexVersionsByRef(versions: Version[] | undefined): Map<string, Version> {
  const byRef = new Map<string, Version>();
  if (versions !== undefined) {
    for (const version of versions) {
      const ref = version.lineage === undefined ? undefined : version.lineage.snapshotRef;
      if (ref !== undefined) {
        byRef.set(ref, version);
      }
    }
  }
  return byRef;
}

type IngestFailure = { error: string; label: string };

function reportIngest(ingestedCount: number, failed: IngestFailure[]): void {
  if (ingestedCount === 0 && failed.length === 0) {
    toast.info("Nothing to ingest — every snapshot already has a frozen version.");
    return;
  }
  if (ingestedCount > 0) {
    toast.success(
      `Ingested ${ingestedCount} snapshot${ingestedCount === 1 ? "" : "s"} as frozen version${
        ingestedCount === 1 ? "" : "s"
      }.`,
    );
  }
  for (const failure of failed) {
    toast.error(`"${failure.label}" failed to ingest: ${failure.error}`);
  }
}

function SnapshotRow({ snapshot, version }: { snapshot: Snapshot; version: Version | undefined }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Camera className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{snapshot.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {snapshot.rowCount} rows · taken{" "}
            {formatDistanceToNow(new Date(snapshot.createdAt), { addSuffix: true })} ·{" "}
            <span className="font-mono">{snapshot.ref}</span>
          </p>
        </div>
      </div>
      {version !== undefined ? (
        <Badge variant="outline" className="shrink-0" title="Frozen as a version dataset">
          <Tag />
          Ingested
        </Badge>
      ) : (
        <Badge variant="secondary" className="shrink-0">
          Not ingested
        </Badge>
      )}
    </li>
  );
}
