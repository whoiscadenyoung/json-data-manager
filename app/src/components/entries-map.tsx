import { buildFeatureCollection, computeBbox } from "@caden/json-cms/react";
import type { Geometry } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";
import { Map as MapIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Map, MapGeoJSON } from "#/components/ui/map";
import { api } from "#convex/_generated/api";

type GeometryEntry = FunctionReturnType<typeof api.geometries.list>[number];

/**
 * A "dumb" presentational map view of a dataset's geometries — receives data
 * as a prop rather than querying internally, matching `EntriesTable`'s own
 * pattern.
 */
export function EntriesMap({ geometries }: { geometries: GeometryEntry[] }) {
  if (geometries.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MapIcon />
          </EmptyMedia>
          <EmptyTitle>No geometry yet</EmptyTitle>
          <EmptyDescription>Entries with geometry will appear here on the map.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const collection = buildFeatureCollection(
      geometries.map((g) => ({
        id: g.entryId,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `GeometryDoc.geometry` is widened to `unknown`, but every row in the `geometries` table was validated as a real `Geometry` at write time.
        geometry: g.geometry as Geometry,
        properties: {},
      })),
    ),
    // `collection.bbox` is typed as the `geojson` package's wider `BBox` (4- or
    // 6-tuple); `computeBbox` has its own narrower `BoundingBox` (always 4)
    // return type, which is what MapLibre's `LngLatBoundsLike` actually accepts.
    bbox = computeBbox(collection);

  return (
    <div className="h-[500px] w-full overflow-hidden rounded-lg border border-border">
      <Map bounds={bbox} className="h-full w-full">
        <MapGeoJSON data={collection} />
      </Map>
    </div>
  );
}
