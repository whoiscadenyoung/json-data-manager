import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  useMapTileArchiveBuildState,
  type TileArchiveBuildState,
} from "@/lib/tile-archive";

/**
 * Overlay chip for one dataset's tile-archive build state (issue #58 part 4's
 * "subtle UI indicator", made real by #71 — the state store existed but
 * nothing rendered it, so a failed build was invisible to users).
 *
 * Renders nothing while `idle`. Active phases show a spinner badge; terminal
 * states flash for a few seconds (the store reverts them), except failures,
 * which a toast also reports page-wide — this chip only exists on the dataset
 * page, the toast everywhere.
 */

/** Copy per state — only non-idle states render. */
const STATE_LABELS: Record<Exclude<TileArchiveBuildState, "idle">, string> = {
  scheduled: "Tile rebuild queued",
  fetching: "Fetching features…",
  building: "Building tiles…",
  uploading: "Uploading archive…",
  installing: "Installing archive…",
  done: "Tiles updated",
  "stale-discarded": "Rebuild superseded — retrying",
  error: "Tile rebuild failed",
};

const ACTIVE_STATES: ReadonlySet<TileArchiveBuildState> = new Set([
  "scheduled",
  "fetching",
  "building",
  "uploading",
  "installing",
]);

export function TileBuildStatus({ schemaId }: { schemaId: string }) {
  const state = useMapTileArchiveBuildState(schemaId);
  if (state === "idle") {
    return null;
  }
  const active = ACTIVE_STATES.has(state),
    failed = state === "error",
    updated = state === "done";
  return (
    <div className="pointer-events-none absolute top-3 right-3 z-10">
      <Badge
        variant={failed ? "destructive" : updated ? "default" : "secondary"}
        className="gap-1.5 shadow-sm"
      >
        {active && <Loader2 className="h-3 w-3 animate-spin" />}
        {updated && <CheckCircle2 className="h-3 w-3" />}
        {failed && <TriangleAlert className="h-3 w-3" />}
        {STATE_LABELS[state]}
      </Badge>
    </div>
  );
}
