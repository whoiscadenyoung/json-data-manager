// Public API of the views feature (ADR 0014). Code outside `features/views/`
// imports from here, never from its subfolders.
export { PgViewPage } from "./components/pg-view-page";
export { ProjectViewsSection, ViewCard } from "./components/project-views-section";
export { createProjectView } from "./lib/create-view";
export { definitionFromRelation } from "./lib/view-model";
export type { RelationSeed } from "./lib/view-model";
