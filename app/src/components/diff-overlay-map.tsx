import type * as GeoJSON from "geojson";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect, useMemo } from "react";

import { cn } from "#/lib/utils";
import { Map, useMap } from "#/components/ui/map";

/**
 * A dedicated GeoJSON overlay map for bound-dataset diffs (#77): commit
 * highlights and tag compares render here as their own point source, never
 * touching any dataset's tile source (docs/bound-datasets-design.md §7 —
 * Placemark's split-source render-sync lesson). Adds render green,
 * modifications amber, deletes red; deletes' former positions show when the
 * caller can supply them (tag compares), otherwise they're listed in the
 * panel beside the map.
 */
export type DiffPointStatus = "add" | "delete" | "update";

export type DiffPoint = {
  key: string;
  label: string;
  lat: number;
  lng: number;
  status: DiffPointStatus;
};

const STATUS_COLORS: Record<DiffPointStatus, string> = {
  add: "#16a34a",
  delete: "#dc2626",
  update: "#d97706",
};

export const DIFF_STATUS_LABELS: Record<DiffPointStatus, string> = {
  add: "Added",
  delete: "Removed",
  update: "Modified",
};

/** Adds the overlay source + one data-driven circle layer, replacing on change. */
function OverlaySource({ points }: { points: DiffPoint[] }) {
  const context = useMap(),
    map = context.map,
    isLoaded = context.isLoaded,
    sourceId = "diff-overlay-points",
    layerId = "diff-overlay-circles",
    featureCollection = useMemo<GeoJSON.FeatureCollection>(
      () => ({
        features: points.map((point) => ({
          geometry: { coordinates: [point.lng, point.lat], type: "Point" },
          properties: { color: STATUS_COLORS[point.status], label: point.label },
          type: "Feature",
        })),
        type: "FeatureCollection",
      }),
      [points],
    );

  useEffect(() => {
    if (!isLoaded || map === null) {
      return;
    }
    if (map.getSource(sourceId) !== undefined) {
      void (map.getSource(sourceId) as GeoJSONSource).setData(featureCollection);
      return;
    }
    map.addSource(sourceId, { data: featureCollection, type: "geojson" });
    map.addLayer({
      id: layerId,
      layout: {},
      paint: {
        "circle-color": ["get", "color"],
        "circle-opacity": 0.9,
        "circle-radius": 7,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
      source: sourceId,
      type: "circle",
    });
    return () => {
      // Own the layer's lifecycle: on unmount (or the parent Map switching
      // themes/remounts), remove so a stale layer never outlives its source.
      if (map.getLayer(layerId) !== undefined) {
        map.removeLayer(layerId);
      }
      if (map.getSource(sourceId) !== undefined) {
        map.removeSource(sourceId);
      }
    };
  }, [map, isLoaded, featureCollection]);

  return null;
}

export function DiffOverlayMap({
  className,
  points,
}: {
  className?: string;
  points: DiffPoint[];
}) {
  const bounds = useMemo<[number, number, number, number] | undefined>(() => {
    if (points.length === 0) {
      return undefined;
    }
    const lats = points.map((point) => point.lat),
      lngs = points.map((point) => point.lng);
    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  }, [points]);
  const statuses = new Set(points.map((point) => point.status));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative h-64 w-full overflow-hidden rounded-lg border border-border">
        <Map bounds={bounds} className="h-full w-full">
          <OverlaySource points={points} />
        </Map>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {[...statuses].map((status) => (
          <span className="flex items-center gap-1.5" key={status}>
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: STATUS_COLORS[status] }}
            />
            {DIFF_STATUS_LABELS[status]}
          </span>
        ))}
        <span className="ml-auto font-mono">{points.length} feature(s)</span>
      </div>
    </div>
  );
}
