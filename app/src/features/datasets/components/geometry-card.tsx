import type { Geometry } from "@caden/json-cms/react";
import { computeBbox } from "@caden/json-cms/react";
import { Badge } from "@caden/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@caden/ui/components/collapsible";
import { Map, MapClusterLayer, MapGeoJSON } from "@caden/ui/components/map";
import { ChevronDown, Code2, MapPinned } from "lucide-react";
import { useState } from "react";

import { bboxFeature, buildPointFeatureCollection } from "#/features/maps";

/**
 * Paints matching the dataset map's feature styling, so an entry reads the
 * same in both places.
 */
const FEATURE_FILL_PAINT = { "fill-color": "#3b82f6", "fill-opacity": 0.2 },
  FEATURE_LINE_PAINT = { "line-color": "#3b82f6", "line-width": 2 },
  // Dashed rectangle framing the geometry's bounding box, matching the
  // dataset map's extent outline.
  BBOX_LINE_PAINT = {
    "line-color": "#3b82f6",
    "line-width": 1.5,
    "line-dasharray": [2, 1.5] as number[],
  };

/** The geometry-row fields the card reads — both backends' rows carry them (Convex via the seam's row shape). */
export interface GeometryCardRow {
  entryId: string;
  type: string;
}

/**
 * The right rail for a geospatial entry: a minimap framing the geometry and
 * its bounding box, over a collapsible raw-GeoJSON view. `geometry` arrives
 * async (inline rows resolve instantly; storage-backed ones after a fetch) —
 * the frame renders immediately with the row's type badge and fills in.
 * Shared by the entry-details route's Convex and Postgres editions.
 */
export function GeometryCard({
  row,
  geometry,
}: {
  row: GeometryCardRow;
  geometry: Geometry | undefined;
}) {
  const [geoJsonOpen, setGeoJsonOpen] = useState(false),
    bbox = geometry ? computeBbox(geometry) : undefined,
    // Fill/line layers draw nothing for point geometries — those render via
    // the circle-layer cluster component instead (same split as the dataset map).
    isPointLike =
      geometry !== undefined && (geometry.type === "Point" || geometry.type === "MultiPoint");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPinned className="h-5 w-5" />
          Geometry
        </CardTitle>
        <CardDescription>
          <Badge variant="outline">{row.type}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative h-56 overflow-hidden rounded-lg border border-border">
          {geometry && (
            <Map bounds={bbox} fitBoundsOptions={{ padding: 24 }} className="h-full w-full">
              {bbox && (
                <MapGeoJSON
                  data={bboxFeature(bbox)}
                  id="entry-bbox"
                  fillPaint={false}
                  linePaint={BBOX_LINE_PAINT}
                />
              )}
              {isPointLike ? (
                <MapClusterLayer<{ entryId: string }>
                  data={buildPointFeatureCollection<{ entryId: string }>([
                    { id: row.entryId, geometry, properties: { entryId: row.entryId } },
                  ])}
                />
              ) : (
                <MapGeoJSON
                  data={geometry}
                  fillPaint={FEATURE_FILL_PAINT}
                  linePaint={FEATURE_LINE_PAINT}
                />
              )}
            </Map>
          )}
        </div>
        <Collapsible
          open={geoJsonOpen}
          onOpenChange={(next) => {
            setGeoJsonOpen(next);
          }}
        >
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted/50">
            <span className="flex items-center gap-2">
              <Code2 className="h-4 w-4" />
              GeoJSON
            </span>
            <ChevronDown
              className="size-4 text-muted-foreground transition-transform"
              style={{ rotate: geoJsonOpen ? "180deg" : undefined }}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3">
              {geometry === undefined ? (
                <p className="text-xs text-muted-foreground">Loading geometry…</p>
              ) : (
                <pre className="text-xs">{JSON.stringify(geometry, null, 2)}</pre>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
