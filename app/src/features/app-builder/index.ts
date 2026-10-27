// Public API of the app builder feature module (ADR 0011, ADR 0014). Code
// outside `features/app-builder/` imports from here, never from internals.
export { pageSearch } from "./lib/pages";
export { AppBuilderPage } from "./pages/app-builder-page";
export { AppViewPage } from "./pages/app-view-page";
export { AppsPage } from "./pages/apps-page";
