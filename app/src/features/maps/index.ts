// Public API of the maps feature (ADR 0014). Code outside `features/maps/`
// imports from here, never from its subfolders.
export { EntriesMap } from "./components/entries-map";
export { LayersMap } from "./components/layers-map";
export { ProjectMapEditor } from "./components/map-editor/map-editor";
export { StoredMapCanvas } from "./components/stored-map-canvas";
export { useGeometriesByDatasets } from "./components/geometries-loader";
export type { LayersMapExtension, LayersMapLayerArgs } from "./components/layers-map";
export { TileBuildStatus } from "./components/tile-build-status";
export {
  layerSourceKind,
  splitDatasetIdsByDecision,
  useTileArchiveSource,
  useTileArchiveSources,
} from "./lib/layer-source";
export type { LayerSourceSplit } from "./lib/layer-source";
export { colorForIndex } from "./lib/map-layers";
export { MAP_TILE_ARCHIVE_FORMAT, MAP_TILE_ARCHIVE_MIN_BYTES } from "./lib/tile-archive-state";
export { buildFrozenTileArchive } from "./lib/frozen-archive-build";
export type { FrozenArchiveStamp } from "./lib/frozen-archive-build";
export { bboxFeature, buildPointFeatureCollection } from "./lib/point-geometry";
export {
  outputOfDefinition,
  outputOfViewDefinition,
  outputSchemaOf,
  popupFieldsFromView,
  popupInputsOf,
  popupOverrideOf,
  resolvePopupFields,
  usePopupFieldsFor,
} from "./lib/popup-fields";
export type { PopupField } from "./lib/popup-fields";
export { PopupFieldsDialog } from "./components/popup-fields-dialog";
