// Public API of the versions feature (ADR 0014). Code outside `features/versions/`
// imports from here, never from its subfolders.
export {
  ChainVersionsCard,
  ConsumedByCard,
  SourceDriftCard,
} from "./components/dataset-consumption";
export { DatasetHistoryPanel } from "./components/dataset-history-panel";
export { RemoteSourceControls } from "./components/remote-source-controls";
export { VersionCompare } from "./components/version-compare";
export { isSyncStale } from "./lib/sync-staleness";
