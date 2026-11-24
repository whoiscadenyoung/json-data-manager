// Public API of the versions feature (ADR 0014). Code outside `features/versions/`
// imports from here, never from its subfolders.
export {
  DiffOverlayMap,
  type DiffPoint,
  type DiffPointStatus,
} from "./components/diff-overlay-map";
export { PgConsumersCard, PgVersionsCard } from "./components/pg-versions-card";
export { VersionCompareView } from "./components/version-compare";
export { isSyncStale } from "./lib/sync-staleness";
