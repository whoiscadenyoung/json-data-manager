import type { FunctionReturnType } from "convex/server";
import {
  AlertTriangle,
  CircleDashed,
  Database,
  GitFork,
  MapPin,
  RefreshCw,
  Tag,
  Unlink,
} from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { api } from "#convex/_generated/api";

export type DatasetSummary = FunctionReturnType<typeof api.schemas.listSummaries>[number];

/** One per-source drift badge row, as `consumption.sourceBadges` returns it. */
export type SourceBadge = FunctionReturnType<
  typeof api.consumption.sourceBadges
>["bySchemaId"][string][number];

/**
 * The "source published vN" badges (roadmap stage 6, #101; lifecycle §7) —
 * the sourceUpdatedAt binding-badge pattern generalized to version chains:
 * one badge per consumed source whose recorded freeze differs from the
 * chain's current head. In-app only, like the pattern it generalizes.
 * "current"/"live" render nothing.
 *
 * Deliberate list coverage (stage 6): the datasets browser's standalone,
 * derived, and group-member rows. The other DatasetTypeTags surfaces —
 * DatasetList's group/collection rows and the profile page's per-creator
 * list — don't subscribe to the badges query yet; the dataset page's Sources
 * card is the authoritative drift read, so nothing is silently missing
 * there, and widening is a keyed-`schemaIds` prop away.
 */
export function SourceDriftBadges({ badges }: { badges: SourceBadge[] | undefined }) {
  if (badges === undefined) {
    return null;
  }
  return (
    <>
      {badges.map((badge) => {
        if (badge.state === "drift") {
          return (
            <Badge
              key={badge.sourceDatasetId}
              variant="destructive"
              title={`A source published ${badge.headVersionLabel ?? "a new version"} since this was frozen${
                badge.recordedVersionLabel === undefined
                  ? ""
                  : ` (this uses ${badge.recordedVersionLabel})`
              } — review the diff on the dataset page, then sync or repin.`}
            >
              <AlertTriangle />
              Source published {badge.headVersionLabel ?? "a new version"}
            </Badge>
          );
        }
        if (badge.state === "missing") {
          return (
            <Badge
              key={badge.sourceDatasetId}
              variant="outline"
              title="The source version this was frozen against no longer exists (retired or deleted) — sync to the current head."
            >
              <Unlink />
              Source version gone
            </Badge>
          );
        }
        return null;
      })}
    </>
  );
}

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
        title={
          reason ??
          "A dataset this transform reads changed since it was written — review it on the source's Transform tab."
        }
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
 *
 * `draftTitle` overrides the Draft badge's tooltip where the viewing context
 * differs from the drafts toggle (the project workspace shows the caller
 * their own project's contents, not a toggle-on catalog view).
 */
export function DatasetTypeTags({
  dataset,
  draftTitle,
}: {
  dataset: DatasetSummary;
  draftTitle?: string;
}) {
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
      {dataset.lifecycle === "draft" && (
        <Badge
          variant="outline"
          title={
            draftTitle ??
            "Draft — hidden from the catalog for consumers; you're seeing it via the drafts toggle."
          }
        >
          <CircleDashed />
          Draft
        </Badge>
      )}
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
