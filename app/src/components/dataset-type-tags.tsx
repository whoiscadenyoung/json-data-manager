import { Badge } from "@caden/ui/components/badge";
import type { FunctionReturnType } from "convex/server";
import {
  AlertTriangle,
  CircleDashed,
  Database,
  Lock,
  MapPin,
  PencilOff,
  RefreshCw,
  Tag,
  Unlink,
} from "lucide-react";

import { api } from "#convex/_generated/api";

export type DatasetSummary = FunctionReturnType<typeof api.cms.schemas.listSummaries>[number];

/** One per-source drift badge row, as `consumption.sourceBadges` returns it. */
export type SourceBadge = FunctionReturnType<
  typeof api.versions.consumption.sourceBadges
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
      {dataset.publishedVisibility === "author" && (
        <Badge
          variant="outline"
          title="Only you can see this dataset — other signed-in users can't (the catalog, collections, and profiles all hide it from them)."
        >
          <Lock />
          Only me
        </Badge>
      )}
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
      {dataset.editPolicy === "locked" && (
        <Badge
          variant="outline"
          title="Locked by the creator — only they can edit this dataset. Everyone signed in can still view and export it."
        >
          <PencilOff />
          Locked
        </Badge>
      )}
    </>
  );
}
