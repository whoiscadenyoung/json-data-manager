import type { FunctionReturnType } from "convex/server";
import { AlertTriangle, Database, GitFork, MapPin, RefreshCw, Tag, Unlink } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { api } from "#convex/_generated/api";

export type DatasetSummary = FunctionReturnType<typeof api.schemas.listSummaries>[number];

/**
 * A registry row's read-time health (roadmap stage 2, #95): "stale" when a
 * declared key/field no longer exists on a source's declared structure,
 * "orphaned" when a source dataset is gone — the one compute-on-read signal
 * every derived-dataset surface shares. Nothing renders for "ready".
 */
export function DerivedHealthBadges({
  health,
  reason,
}: {
  health: "orphaned" | "ready" | "stale";
  reason?: string;
}) {
  if (health === "ready") {
    return null;
  }
  if (health === "stale") {
    return (
      <Badge
        variant="outline"
        title={reason ?? "A dataset this transform reads changed since it was written — review it on the source's Transform tab."}
      >
        <AlertTriangle />
        Stale
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      title={reason ?? "A dataset this transform reads no longer exists."}
    >
      <Unlink />
      Orphaned
    </Badge>
  );
}

/** The derived-dataset badge (§3: derived datasets appear badged as derived). */
export function DerivedDatasetBadge() {
  return (
    <Badge
      variant="default"
      title="A virtual dataset — computed from a transform spec over other datasets. Source data is never modified."
    >
      <GitFork />
      Derived
    </Badge>
  );
}

/**
 * Type tags for a dataset: Geospatial plus its geometry type, or Regular —
 * plus a "Synced" marker when the dataset is a read-only projection of a
 * connected external source, and the snapshot version label when it's a
 * frozen tag version (lineage). Rendered above/next to dataset titles across
 * the list views (browser cards, group rows, collection rows) so each list
 * reads at a glance.
 */
export function DatasetTypeTags({ dataset }: { dataset: DatasetSummary }) {
  return (
    <>
      {dataset.kind === "geospatial" ? (
        <Badge variant="default">
          <MapPin />
          Geospatial
        </Badge>
      ) : (
        <Badge variant="secondary">
          <Database />
          Regular
        </Badge>
      )}
      {dataset.geometryType && <Badge variant="outline">{dataset.geometryType}</Badge>}
      {dataset.lineage !== undefined && (
        <Badge
          variant="outline"
          title={`Frozen snapshot version "${dataset.lineage.versionLabel}" — a point-in-time copy, read-only here.`}
        >
          <Tag />
          {dataset.lineage.versionLabel}
        </Badge>
      )}
      {dataset.source && (
        <Badge
          variant="outline"
          title={`Read-only — synced from the connected source "${dataset.source.name}". Edit the source data and re-sync instead.`}
        >
          <RefreshCw />
          Synced
        </Badge>
      )}
    </>
  );
}
