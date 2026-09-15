import type { FunctionReturnType } from "convex/server";
import { Database, MapPin } from "lucide-react";

import { Badge } from "#/components/ui/badge";
import { api } from "#convex/_generated/api";

export type DatasetSummary = FunctionReturnType<typeof api.schemas.list>[number];

/**
 * Type tags for a dataset: Geospatial plus its geometry type, or Regular.
 * Rendered above/next to dataset titles across the list views (browser
 * cards, group rows, collection rows) so each list reads at a glance.
 */
export function DatasetTypeTags({ dataset }: { dataset: DatasetSummary }) {
  if (dataset.kind === "geospatial") {
    return (
      <>
        <Badge variant="default">
          <MapPin />
          Geospatial
        </Badge>
        {dataset.geometryType && <Badge variant="outline">{dataset.geometryType}</Badge>}
      </>
    );
  }
  return (
    <Badge variant="secondary">
      <Database />
      Regular
    </Badge>
  );
}
