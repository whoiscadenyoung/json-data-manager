import { buildFeatureCollection, computeBbox } from "@caden/json-cms/react";
import type { Geometry } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";
import { Map as MapIcon, X } from "lucide-react";
import { useState } from "react";

import { formatPropertyValue } from "#/components/entries-map";
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

type GeometryEntry = FunctionReturnType<typeof api.collections.listGeometriesByCollection>[number];
type EntryDoc = FunctionReturnType<typeof api.collections.listEntriesByCollection>[number];
type Dataset = FunctionReturnType<typeof api.schemas.list>[number];

type FeatureProperties = { entryId: string; schemaId: string };

// Cycled per dataset so each shows up as a distinct color on the map/legend.
const DATASET_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

function colorForIndex(index: number) {
  return DATASET_COLORS[index % DATASET_COLORS.length];
}

function groupGeometriesBySchema(geometries: GeometryEntry[]) {
  const bySchema = new globalThis.Map<string, GeometryEntry[]>();
  for (const geometry of geometries) {
    const existing = bySchema.get(geometry.schemaId);
    if (existing) {
      existing.push(geometry);
    } else {
      bySchema.set(geometry.schemaId, [geometry]);
    }
  }
  return bySchema;
}

/** Falls back to `fallback` when the dataset isn't found — avoids an optional-chained `?.title`. */
function getDatasetTitle(
  datasetById: globalThis.Map<string, Dataset>,
  schemaId: string,
  fallback: string,
) {
  const dataset = datasetById.get(schemaId);
  return dataset ? dataset.title : fallback;
}

function FeatureDetailsPanel({
  entry,
  datasetTitle,
  onClose,
}: {
  entry: EntryDoc;
  datasetTitle: string;
  onClose: () => void;
}) {
  const fields = Object.entries(entry.data as Record<string, unknown>);

  return (
    <div className="absolute top-3 right-3 bottom-3 z-10 flex w-64 flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">Feature details</h3>
          <p className="truncate text-xs text-muted-foreground">{datasetTitle}</p>
        </div>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onClose}>
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

/** One color-coded legend swatch per dataset that actually has geometry on the map. */
function MapLegend({ datasets }: { datasets: { schemaId: string; title: string; color: string }[] }) {
  if (datasets.length < 2) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-3">
      {datasets.map((dataset) => (
        <div key={dataset.schemaId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: dataset.color }}
          />
          <span className="truncate">{dataset.title}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A combined map view across multiple datasets — one color-coded `MapGeoJSON`
 * layer per dataset, all sharing a single viewport fit to their union bbox.
 * Used for the group/collection-level "all datasets" map, unlike `EntriesMap`
 * which renders a single dataset.
 */
export function DatasetsMap({
  datasets,
  geometries,
  entries,
}: {
  datasets: Dataset[];
  geometries: GeometryEntry[];
  entries: EntryDoc[];
}) {
  const entryById = new globalThis.Map(entries.map((entry) => [entry._id, entry])),
    datasetById = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset])),
    geometriesBySchema = groupGeometriesBySchema(geometries),
    schemaIds = [...geometriesBySchema.keys()],
    [selected, setSelected] = useState<FeatureProperties | null>(null);

  if (geometries.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MapIcon />
          </EmptyMedia>
          <EmptyTitle>No geometry yet</EmptyTitle>
          <EmptyDescription>
            Geospatial datasets here will appear together on the map.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const combined = buildFeatureCollection<FeatureProperties>(
      geometries.map((geometry) => ({
        id: geometry.entryId,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `GeometryDoc.geometry` is widened to `unknown`, but every row in the `geometries` table was validated as a real `Geometry` at write time.
        geometry: geometry.geometry as Geometry,
        properties: { entryId: geometry.entryId, schemaId: geometry.schemaId },
      })),
    ),
    bbox = computeBbox(combined),
    legendDatasets = schemaIds.map((schemaId, index) => ({
      schemaId,
      title: getDatasetTitle(datasetById, schemaId, "Untitled dataset"),
      color: colorForIndex(index),
    })),
    selectedEntry = selected ? entryById.get(selected.entryId) : undefined,
    selectedDatasetTitle = selected ? getDatasetTitle(datasetById, selected.schemaId, "") : "";

  return (
    <div className="flex flex-col gap-3">
      <MapLegend datasets={legendDatasets} />
      <div className="relative h-[500px] w-full overflow-hidden rounded-lg border border-border">
        <Map bounds={bbox} className="h-full w-full">
          {schemaIds.map((schemaId, index) => {
            const color = colorForIndex(index),
              schemaGeometries = geometriesBySchema.get(schemaId) ?? [],
              collection = buildFeatureCollection<FeatureProperties>(
                schemaGeometries.map((geometry) => ({
                  id: geometry.entryId,
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
                  geometry: geometry.geometry as Geometry,
                  properties: { entryId: geometry.entryId, schemaId: geometry.schemaId },
                })),
              );
            return (
              <MapGeoJSON<FeatureProperties>
                key={schemaId}
                data={collection}
                interactive
                fillPaint={{ "fill-color": color, "fill-opacity": 0.2 }}
                linePaint={{ "line-color": color, "line-width": 2 }}
                fillHoverPaint={{ "fill-opacity": 0.35 }}
                onClick={(e) => {
                  setSelected({
                    entryId: e.feature.properties.entryId,
                    schemaId: e.feature.properties.schemaId,
                  });
                }}
              />
            );
          })}
        </Map>
        {selectedEntry && (
          <FeatureDetailsPanel
            entry={selectedEntry}
            datasetTitle={selectedDatasetTitle}
            onClose={() => {
              setSelected(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
