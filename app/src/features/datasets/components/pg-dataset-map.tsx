import {
  EntriesMap,
  TileBuildStatus,
  layerSourceKind,
  useGeometriesByPgDatasets,
  useTileArchiveSource,
} from "#/features/maps";
import type { DatasetBoundingBox, DatasetRow } from "@/lib/store/datasets";

/** The dataset's stored envelope (a GeoJSON polygon ring) as `[minLon, minLat, maxLon, maxLat]`. */
function envelopeOf(bbox: DatasetBoundingBox | null): [number, number, number, number] | undefined {
  if (bbox === null) {
    return undefined;
  }
  const ring = bbox.coordinates[0];
  if (ring === undefined || ring.length === 0) {
    return undefined;
  }
  const lons = ring.map((point) => point[0] ?? 0),
    lats = ring.map((point) => point[1] ?? 0);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/**
 * The dataset's preview map (issue #271 follow-up; the Convex-era page had it
 * and the Postgres port dropped it): the dataset's default-styled points,
 * lines and polygons with a dashed box drawn on the stored extent. It rides
 * the tile archive when a fresh one exists and the paginated geometry rows
 * otherwise — the same decision the project map editor makes.
 */
export function PgDatasetMap({ dataset }: { dataset: DatasetRow }) {
  const decision = useTileArchiveSource(dataset, dataset.id),
    rowPath = layerSourceKind(decision) === "rows",
    fan = useGeometriesByPgDatasets(rowPath ? [dataset.id] : []);
  return (
    <section className="relative mb-6">
      {fan.loaders}
      <EntriesMap
        className="h-[420px]"
        entries={[]}
        geometries={fan.servedGeometries ?? []}
        initialBbox={envelopeOf(dataset.bbox)}
        isLoading={rowPath && fan.geometries === undefined}
        key={dataset.id}
        source={decision}
      />
      <TileBuildStatus schemaId={dataset.id} />
    </section>
  );
}
