// Public API of the datasets feature (ADR 0014). Code outside `features/datasets/`
// imports from here, never from its subfolders.
export { DatasetList } from "./components/dataset-list";
export type { Dataset, GroupDoc } from "./components/dataset-list";
export { EntriesTable } from "./components/entries-table";
export { EntryFormPanel } from "./components/entry-form-panel";
export type { PanelEntry, PanelSchema } from "./components/entry-form-panel";
export { ExportDialog } from "./components/export-dialog";
export type { ExportFormat, ExportFormatOption } from "./components/export-dialog";
export { GeometryCard } from "./components/geometry-card";
export type { GeometryCardRow } from "./components/geometry-card";
export { PostgresCreateDatasetPage } from "./components/pg-create-flow";
export { PostgresDatasetPage } from "./components/pg-dataset-page";
export type { PgDatasetPageSearch } from "./components/pg-dataset-page";
export { PgDatasetExport } from "./components/pg-dataset-export";
export { PgGroupExport } from "./components/pg-group-export";
export { PostgresEntryDetailsPage } from "./components/pg-entry-details";
export { SchemaVisualizer } from "./components/schema-visualizer";
export { SimplifyGeometryPanel } from "./components/simplify-geometry-panel";
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
  pgTableParamsFromState,
  pgTableStateFromParams,
  useSearchEntriesPages,
} from "./lib/pg-entries-table";
export {
  buildLabelsByField,
  collectReferencedIds,
  isRecord,
  referencedEntryIds,
} from "./lib/reference-labels";
export { uploadChunkBlob, uploadSourceFileBlob } from "./lib/upload";
export { DatasetProjectContext, useDatasetLinks } from "./lib/dataset-project-context";
