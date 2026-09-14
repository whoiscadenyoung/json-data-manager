import { buildFeatureCollection, computeBbox } from "@caden/json-cms/react";
import type { Geometry } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";
import { Map as MapIcon, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "#/components/ui/button";
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
type EntryDoc = FunctionReturnType<typeof api.entries.list>[number];

type FeatureProperties = { entryId: string };

const FEATURE_FILL_PAINT = { "fill-color": "#3b82f6", "fill-opacity": 0.2 },
  FEATURE_LINE_PAINT = { "line-color": "#3b82f6", "line-width": 2 },
  FEATURE_FILL_HOVER_PAINT = { "fill-opacity": 0.35 };

export function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function FeatureDetailsPanel({
  entry,
  onClose,
}: {
  entry: EntryDoc;
  onClose: () => void;
}) {
  const fields = Object.entries(entry.data as Record<string, unknown>);

  return (
    <div className="absolute top-3 right-3 bottom-3 z-10 flex w-64 flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold">Feature details</h3>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <dl className="flex-1 space-y-3 overflow-y-auto p-3">
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No properties on this entry.</p>
        ) : (
          fields.map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
              <dd className="text-sm break-words">{formatPropertyValue(value)}</dd>
            </div>
          ))
        )}
      </dl>
    </div>
  );
}

/**
 * A "dumb" presentational map view of a dataset's geometries — receives data
 * as a prop rather than querying internally, matching `EntriesTable`'s own
 * pattern.
 */
export function EntriesMap({
  geometries,
  entries,
}: {
  geometries: GeometryEntry[];
  entries: EntryDoc[];
}) {
  const entryById = useMemo(
    () => new globalThis.Map(entries.map((entry) => [entry._id, entry])),
    [entries],
  );
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

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

  const collection = buildFeatureCollection<FeatureProperties>(
      geometries.map((g) => ({
        id: g.entryId,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `GeometryDoc.geometry` is widened to `unknown`, but every row in the `geometries` table was validated as a real `Geometry` at write time.
        geometry: g.geometry as Geometry,
        properties: { entryId: g.entryId },
      })),
    ),
    // `collection.bbox` is typed as the `geojson` package's wider `BBox` (4- or
    // 6-tuple); `computeBbox` has its own narrower `BoundingBox` (always 4)
    // return type, which is what MapLibre's `LngLatBoundsLike` actually accepts.
    bbox = computeBbox(collection),
    selectedEntry = selectedEntryId ? entryById.get(selectedEntryId) : undefined;

  return (
    <div className="relative h-[500px] w-full overflow-hidden rounded-lg border border-border">
      <Map bounds={bbox} className="h-full w-full">
        <MapGeoJSON
          data={collection}
          interactive
          fillPaint={FEATURE_FILL_PAINT}
          linePaint={FEATURE_LINE_PAINT}
          fillHoverPaint={FEATURE_FILL_HOVER_PAINT}
          onClick={(e) => setSelectedEntryId(e.feature.properties.entryId)}
        />
      </Map>
      {selectedEntry && (
        <FeatureDetailsPanel entry={selectedEntry} onClose={() => setSelectedEntryId(null)} />
      )}
    </div>
  );
}
