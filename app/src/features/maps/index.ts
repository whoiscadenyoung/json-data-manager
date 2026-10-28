// Public API of the maps feature (ADR 0014). Code outside `features/maps/`
// imports from here, never from its subfolders.
export { AddToMapSheet } from "./components/add-to-map-sheet";
export { CollectionExtentMap } from "./components/datasets-map";
export { EntriesMap } from "./components/entries-map";
export { GroupMap } from "./components/group-map";
export { LayersMap } from "./components/layers-map";
export type { LayersMapExtension, LayersMapLayerArgs } from "./components/layers-map";
export { MapFormPanel } from "./components/map-form-panel";
export { MapLayerPanel } from "./components/map-layer-panel";
export type { DatasetActionsSlot } from "./components/map-layer-panel";
export { MapLayerPickerSheet } from "./components/map-layer-picker";
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
  renderTargetsForDerivedLayers,
  resolveVisibleSchemaIds,
} from "./lib/map-layers";
export type { DerivedDatasetSummary, MapLayerDoc, MembershipRow } from "./lib/map-layers";
export { bboxFeature, buildPointFeatureCollection } from "./lib/point-geometry";
