import type { FunctionReturnType } from "convex/server";
import { Database, MapPin, RefreshCw } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { api } from "#convex/_generated/api";

export type DatasetSummary = FunctionReturnType<typeof api.schemas.list>[number];

/**
 * Type tags for a dataset: Geospatial plus its geometry type, or Regular —
 * plus a "Synced" marker when the dataset is a read-only projection of a
 * connected external source. Rendered above/next to dataset titles across
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
