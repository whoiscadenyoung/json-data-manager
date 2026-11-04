import { Badge } from "@caden/ui/components/badge";
import { CircleDashed, Database, Lock, MapPin, PencilOff } from "lucide-react";

import type { DatasetSummaryRow } from "#/lib/store/datasets";

import { datasetCountLabel } from "../lib/pg-dataset-view";

/**
 * The Postgres dataset's type-tag row — the core `DatasetTypeTags` badge set
 * (ui-polish info parity: every list view reads at a glance) driven by the
 * store's `DatasetSummaryRow` (`isGeospatial` instead of the component's
 * `kind` union). Rendered by the browser cards, collection/group member
 * rows, and the profile page's dataset list alike — new PG list views keep
 * this component rather than re-deriving per-page badge markup.
 *
 * The Convex component's Synced/lineage badges have no PG state at this
 * stage (bindings are stage 7, versions stage 4) and are absent here rather
 * than dead.
 */
export function PgDatasetTypeTags({ dataset }: { dataset: DatasetSummaryRow }) {
  return (
    <>
      {dataset.isGeospatial ? (
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
      {dataset.geometryType !== null && <Badge variant="outline">{dataset.geometryType}</Badge>}
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
          title="Draft — hidden from the catalog for consumers; you're seeing it via the drafts toggle."
        >
          <CircleDashed />
          Draft
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

/** The tags row plus the trigger-maintained count label ("N features" / "N rows") — the member-row presentation shared by every PG list. */
export function PgDatasetTagsWithCount({ dataset }: { dataset: DatasetSummaryRow }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <PgDatasetTypeTags dataset={dataset} />
      <span className="text-xs text-muted-foreground">{datasetCountLabel(dataset)}</span>
    </div>
  );
}
