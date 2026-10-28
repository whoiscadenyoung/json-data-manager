import type { TileArchiveBuildState } from "@caden/maps/build-scheduler";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@caden/ui/components/alert";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { CheckCircle2, Loader2, RotateCw, TriangleAlert } from "lucide-react";

import {
  ensureMapTileArchive,
  type TileArchiveBuildFailure,
  useMapTileArchiveBuildFailure,
  useMapTileArchiveBuildState,
} from "../lib/tile-archive";

/**
 * Overlay for one dataset's tile-archive build state (issue #58 part 4's
 * "subtle UI indicator", made real by #71 — the state store existed but
 * nothing rendered it, so a failed build was invisible to users).
 *
 * Renders nothing while `idle`. Active phases show a spinner badge; success
 * and supersession flash for a few seconds (the store reverts them). A
 * failure stays as a "map tiles failed to build" alert with the error, the
 * next automatic retry, and a manual retry until a build succeeds (#184) —
 * a running retry swaps back to the spinner badge.
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

const retryTimeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function TileBuildFailure({
  failure,
  schemaId,
}: {
  failure: TileArchiveBuildFailure;
  schemaId: string;
}) {
  return (
    <div className="absolute top-3 right-3 z-10 w-72 max-w-[calc(100%-1.5rem)]">
      <Alert variant="destructive" className="shadow-sm">
        <TriangleAlert />
        <AlertTitle>Map tiles failed to build</AlertTitle>
        <AlertDescription>
          <p className="line-clamp-3 break-words" title={failure.message}>
            {failure.message}
          </p>
          <p>
            {failure.retryAt === undefined
              ? "The map still shows features from the dataset rows."
              : `Retrying automatically at ${retryTimeFormat.format(failure.retryAt)}.`}
          </p>
        </AlertDescription>
        <AlertAction>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              ensureMapTileArchive(schemaId);
            }}
          >
            <RotateCw />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}

export function TileBuildStatus({ schemaId }: { schemaId: string }) {
  const state = useMapTileArchiveBuildState(schemaId),
    failure = useMapTileArchiveBuildFailure(schemaId),
    active = ACTIVE_STATES.has(state);
  if (failure !== undefined && !active) {
    return <TileBuildFailure failure={failure} schemaId={schemaId} />;
  }
  if (state === "idle") {
    return null;
  }
  const failed = state === "error",
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
