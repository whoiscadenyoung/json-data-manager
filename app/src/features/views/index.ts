// Public API of the views feature (ADR 0014). Code outside `features/views/`
// imports from here, never from its subfolders.
export { PgViewPage } from "./components/pg-view-page";
export { CreateViewSheet } from "./components/create-view-sheet";
export { ProjectViewsSection, ViewCard } from "./components/project-views-section";
export { createProjectView } from "./lib/create-view";
export {
  definitionFromRelation,
  definitionFromScratch,
  referencedScratchTables,
} from "./lib/view-model";
export type { PickerDataset, RelationSeed, ScratchTableInfo } from "./lib/view-model";
