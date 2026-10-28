// Public API of the datasets feature (ADR 0014). Code outside `features/datasets/`
// imports from here, never from its subfolders.
export { DatasetList } from "./components/dataset-list";
export type { Dataset, GroupDoc } from "./components/dataset-list";
export { DatasetOverview } from "./components/dataset-overview";
export { EntriesTable } from "./components/entries-table";
export { EntryFormPanel } from "./components/entry-form-panel";
export { ExportDialog } from "./components/export-dialog";
export type { ExportFormat, ExportFormatOption } from "./components/export-dialog";
export { GeospatialConversionPanel } from "./components/geospatial-conversion-panel";
export { SchemaVisualizer } from "./components/schema-visualizer";
export { SimplifyGeometryPanel } from "./components/simplify-geometry-panel";
export { withDrafts } from "./lib/dataset-drafts";
export { LOCKED_DATASET_HINT, isLockedForViewer } from "./lib/edit-policy";
export {
  applyJoinedFields,
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadBlob,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "./lib/export";
export { buildLabelsByField, isRecord, referencedEntryIds } from "./lib/reference-labels";
export { uploadChunkBlob, uploadSourceFileBlob } from "./lib/upload";
