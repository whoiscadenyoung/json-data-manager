// Public API of the views feature (ADR 0014). Code outside `features/views/`
// imports from here, never from its subfolders.
export { ViewPage } from "./components/view-page";
export { NewViewPage } from "./components/new-view-page";
export { DuplicateViewDialog } from "./components/duplicate-view-dialog";
export { relativeTime } from "./lib/format";
export { createProjectView } from "./lib/create-view";
export {
  definitionFromRelation,
  definitionFromScratch,
  referencedScratchTables,
} from "./lib/view-model";
export type { PickerDataset, RelationSeed, ScratchTableInfo } from "./lib/view-model";
