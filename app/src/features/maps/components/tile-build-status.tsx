import type { TileArchiveBuildState } from "@caden/maps/build-scheduler";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@caden/ui/components/alert";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { CheckCircle2, Loader2, RotateCw, TriangleAlert } from "lucide-react";

import {
  ensureMapTileArchive,
  type TileArchiveBuildFailure,
  useMapTileArchiveBuildFailure,
  useMapTileArchiveBuildProgress,
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
 *
 * Both sit top-LEFT: the map's top-right corner belongs to the feature
 * details panel and the "Loading features…" pill, and a persistent,
 * clickable alert there covered the panel's header and close button. They
 * also stack one level BELOW those overlays (z-5 vs z-10): on a map too
 * narrow for both side by side, an open panel wins.
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
    <div className="absolute top-3 left-3 z-5 w-72 max-w-[calc(100%-1.5rem)]">
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

const countFormat = new Intl.NumberFormat();

/** "Fetching features… 12,000 / 20,000" with a thin bar, while the row fetch reports progress. */
function FetchProgress({ done, total }: { done: number; total: number }) {
  return (
    <span className="flex flex-col gap-1">
      <span>
        {STATE_LABELS.fetching} {countFormat.format(done)} / {countFormat.format(total)}
      </span>
      <progress
        value={done}
        max={total}
        className="[&::-moz-progress-bar]:bg-foreground [&::-webkit-progress-bar]:bg-foreground/20 [&::-webkit-progress-value]:bg-foreground h-1 w-full appearance-none overflow-hidden rounded-full"
      />
    </span>
  );
}

/** The badge text: the fetch phase swaps in the counted progress once it is reported. */
function BuildStateLabel({
  progress,
  state,
}: {
  progress: { done: number; total: number } | undefined;
  state: Exclude<TileArchiveBuildState, "idle">;
}) {
  if (state === "fetching" && progress !== undefined) {
    return <FetchProgress done={progress.done} total={progress.total} />;
  }
  return STATE_LABELS[state];
}

export function TileBuildStatus({ schemaId }: { schemaId: string }) {
  const state = useMapTileArchiveBuildState(schemaId),
    failure = useMapTileArchiveBuildFailure(schemaId),
    progress = useMapTileArchiveBuildProgress(schemaId),
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
    <div className="pointer-events-none absolute top-3 left-3 z-5">
      <Badge
        variant={failed ? "destructive" : updated ? "default" : "secondary"}
        className="gap-1.5 shadow-sm"
      >
        {active && <Loader2 className="h-3 w-3 animate-spin" />}
        {updated && <CheckCircle2 className="h-3 w-3" />}
        {failed && <TriangleAlert className="h-3 w-3" />}
        <BuildStateLabel progress={progress} state={state} />
      </Badge>
    </div>
  );
}
