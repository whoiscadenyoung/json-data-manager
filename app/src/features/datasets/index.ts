// Public API of the datasets feature (ADR 0014). Code outside `features/datasets/`
// imports from here, never from its subfolders.
export { EntriesTable } from "./components/entries-table";
export { EntryFormPanel } from "./components/entry-form-panel";
export type { PanelEntry, PanelSchema } from "./components/entry-form-panel";
export { ExportDialog } from "./components/export-dialog";
export type { ExportFormat, ExportFormatOption } from "./components/export-dialog";
export { GeometryCard } from "./components/geometry-card";
export type { GeometryCardRow } from "./components/geometry-card";
export { CreateDatasetPage } from "./components/create-flow";
export { DatasetPage } from "./components/dataset-page";
export type { DatasetPageSearch } from "./components/dataset-page";
export { DatasetExport } from "./components/dataset-export";
export { GroupExport } from "./components/group-export";
export { EntryDetailsPage } from "./components/entry-details";
export { SchemaVisualizer } from "./components/schema-visualizer";
export { withDrafts } from "./lib/dataset-drafts";
export { LOCKED_DATASET_HINT, isLockedForViewer } from "./lib/edit-policy";
export {
  buildGeoJsonCollection,
  buildJsonPayload,
  downloadBlob,
  downloadText,
  entryRows,
  exportExcelWorkbook,
  slugify,
} from "./lib/export";
export {
  tableParamsFromState,
  tableStateFromParams,
  useSearchEntriesPages,
} from "./lib/entries-table";
export {
  buildLabelsByField,
  collectReferencedIds,
  isRecord,
  referencedEntryIds,
} from "./lib/reference-labels";
export { uploadChunkBlob, uploadSourceFileBlob } from "./lib/upload";
export { DatasetProjectContext, useDatasetLinks } from "./lib/dataset-project-context";
