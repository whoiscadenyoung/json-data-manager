// Public API of the maps feature (ADR 0014). Code outside `features/maps/`
// imports from here, never from its subfolders.
export { CollectionExtentMap } from "./components/datasets-map";
export { EntriesMap } from "./components/entries-map";
export { GroupMap } from "./components/group-map";
export { LayersMap } from "./components/layers-map";
export { StoredMapCanvas } from "./components/stored-map-canvas";
export { pgGeometryToLayerRow, pgSummaryToDatasetSummary } from "./components/pg-layer-rows";
export { useGeometriesByPgDatasets } from "./components/pg-geometries-loader";
export type { LayersMapExtension, LayersMapLayerArgs } from "./components/layers-map";
export { TileBuildStatus } from "./components/tile-build-status";
export {
  geospatialDatasetsFor,
  layerSourceKind,
  splitSchemaIdsByDecision,
  useTileArchiveSource,
  useTileArchiveSources,
} from "./lib/layer-source";
export type { LayerSourceSplit } from "./lib/layer-source";
export {
  assignDatasetColors,
  buildLayerChildren,
  chainViewOf,
  colorForIndex,
  expandLayerDatasets,
  overridesByLayerId,
  NO_DERIVED_TITLES,
  NO_RENDERABLE_DERIVED,
  resolveVisibleSchemaIds,
} from "./lib/map-layers";
export { MAP_TILE_ARCHIVE_FORMAT, MAP_TILE_ARCHIVE_MIN_BYTES } from "./lib/pg-tile-archives";
export type { DatasetSummary, MapLayerOverride } from "./lib/map-layers";
export type { DerivedDatasetSummary, MapLayerDoc, MembershipRow } from "./lib/map-layers";
export { buildFrozenTileArchive } from "./lib/frozen-archive-build";
export type { FrozenArchiveStamp } from "./lib/frozen-archive-build";
export { bboxFeature, buildPointFeatureCollection } from "./lib/point-geometry";
