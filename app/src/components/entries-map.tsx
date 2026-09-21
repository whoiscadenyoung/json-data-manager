import { buildFeatureCollection, computeBbox, useResolvedGeometries } from "@caden/json-cms/react";
import type { BoundingBox, Geometry } from "@caden/json-cms/react";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import type * as GeoJSON from "geojson";
import { ChevronRight, Loader2, Map as MapIcon, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Map, MapClusterLayer, MapGeoJSON, MapVectorTiles } from "#/components/ui/map";
import { Skeleton } from "#/components/ui/skeleton";
import { formatPropertyValue } from "#/lib/format";
import { layerSourceKind, layerSourceUrl } from "#/lib/layer-source";
import type { TileSourceDecision } from "#/lib/layer-source";
import {
  bboxFeature,
  buildPointFeatureCollection,
  splitPointLikeGeometries,
} from "#/lib/point-geometry";
import { cn } from "#/lib/utils";
import { api } from "#convex/_generated/api";

// `listGeometries` is paginated (see its doc comment in the component) — the
// per-item shape is still `PaginationResult["page"][number]`. `geometries`
// below is a flat array the caller already assembled from every page (see
// `useGeometriesForSchema` in the dataset detail route).
type GeometryEntry = FunctionReturnType<typeof api.geometries.list>["page"][number];
type EntryDoc = FunctionReturnType<typeof api.entries.list>[number];

type FeatureProperties = { entryId: string };

const FEATURE_FILL_PAINT = { "fill-color": "#3b82f6", "fill-opacity": 0.2 },
  FEATURE_LINE_PAINT = { "line-color": "#3b82f6", "line-width": 2 },
  FEATURE_FILL_HOVER_PAINT = { "fill-opacity": 0.35 },
  // GeoLens-style dashed rectangle framing the dataset's extent, drawn under
  // the data layers and never interactive so clicks pass through it.
  EXTENT_LINE_PAINT = { "line-color": "#3b82f6", "line-width": 1.5, "line-dasharray": [2, 1.5] },
  /**
   * How long the skeleton holds while some rows' geometries are still
   * unresolved (external `geometryUrl` fetches in flight) before giving up on
   * a complete first paint — see `pendingCount` in `useEntriesRowReadiness`.
   */
  PENDING_GRACE_MS = 20_000;

function FeatureDetailsPanel({ entry, onClose }: { entry: EntryDoc; onClose: () => void }) {
  const data: Record<string, unknown> = entry.data,
    fields = Object.entries(data);

  return (
    <div className="absolute top-3 right-3 bottom-3 z-10 flex w-64 flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold">Feature details</h3>
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <dl className="flex-1 space-y-3 overflow-y-auto p-3">
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No properties on this entry.</p>
        ) : (
          fields.map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
              <dd className="text-sm break-words">{formatPropertyValue(value)}</dd>
            </div>
          ))
        )}
      </dl>
      <Link
        to="/datasets/$schemaId/$entryId"
        params={{ schemaId: entry.schemaId, entryId: entry._id }}
        className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2 text-xs font-medium text-primary hover:bg-muted/50"
      >
        View details
        <ChevronRight className="size-3" />
      </Link>
    </div>
  );
}

/**
 * Builds a map-renderable feature row for one geometry entry, given its
 * already-resolved `Geometry` (see `useResolvedGeometries` — most rows
 * resolve synchronously from inline `geometryJson`; a rare large geometry
 * stored externally resolves via an async `fetch` instead, so a row can
 * briefly be absent from `resolved` right after the query first loads).
 */
function toFeatureRow(g: GeometryEntry, resolved: Geometry) {
  return {
    id: g.entryId,
    geometry: resolved,
    properties: { entryId: g.entryId },
  };
}

/**
 * The viewport bounds the dataset map opens on: the exact computed extent
 * once the data is complete, the stored envelope before that (a partial
 * computed extent must not drive the viewport — it would zoom in too far
 * and keep growing, the exact jitter this design avoids). The stored extent
 * holds until everything has landed; only then does the exact extent take
 * over (it can differ only after deletions, which the stored envelope never
 * shrinks for). The tile path has no computed extent of its own — the
 * archive's extent tracks the same stored envelope, so the stored extent IS
 * the camera.
 */
function resolveEntriesMapBounds(
  ready: boolean,
  computedBbox: BoundingBox | undefined,
  initialBbox: [number, number, number, number] | undefined,
): BoundingBox | undefined {
  return ready ? (computedBbox ?? initialBbox) : (initialBbox ?? computedBbox);
}

/**
 * The row path's per-row readiness state, extracted so `EntriesMap` itself
 * carries only the path decision (the repo's complexity budget).
 *
 * Rows resolve via `useResolvedGeometries` — most synchronously from inline
 * `geometryJson`; a row backed by external storage is absent until its
 * `fetch` completes. Rows still absent are either fetching or failed —
 * indistinguishable here. Hold readiness while any are pending, but only
 * within a grace period (started once pagination itself is done, so a
 * multi-page dataset still streaming in can't hit the cap): a row whose
 * fetch failed never resolves, and the map must not strand on a skeleton
 * over it.
 */
function useEntriesRowReadiness(geometries: GeometryEntry[], isLoading: boolean) {
  const resolvedGeometries = useResolvedGeometries(geometries),
    resolvableGeometries = useMemo(
      () =>
        geometries.flatMap((g) => {
          const resolved = resolvedGeometries.get(g._id);
          return resolved === undefined ? [] : [{ g, resolved }];
        }),
      [geometries, resolvedGeometries],
    ),
    pendingCount = geometries.length - resolvableGeometries.length,
    [graceElapsed, setGraceElapsed] = useState(false),
    // Latched the first time the row path renders with complete data. Live
    // updates afterwards can briefly flip readiness back to unfinished while
    // the next pass re-reads — that must not re-skeleton a map the user is
    // already looking at.
    [hasRenderedOnce, setHasRenderedOnce] = useState(false),
    rowReady = !isLoading && pendingCount === 0;

  useEffect(() => {
    if (rowReady) {
      // oxlint-disable-next-line react/set-state-in-effect -- one-way latch: flips once after the first complete render so live updates never re-skeleton (see 229150b).
      setHasRenderedOnce(true);
    }
  }, [rowReady]);

  useEffect(() => {
    if (isLoading || pendingCount === 0) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setGraceElapsed(true);
    }, PENDING_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isLoading, pendingCount]);

  return {
    resolvableGeometries,
    graceElapsed,
    hasRenderedOnce,
    rowReady,
  };
}

/** The row-path feature layers (shapes via fill/line, points as circles), extracted for `EntriesMap`'s complexity budget. */
function RowPathFeatureLayers({
  otherCollection,
  pointCollection,
  onSelectEntry,
}: {
  otherCollection: GeoJSON.FeatureCollection<GeoJSON.Geometry, FeatureProperties>;
  pointCollection: GeoJSON.FeatureCollection<GeoJSON.Point, FeatureProperties>;
  onSelectEntry: (entryId: string) => void;
}) {
  return (
    <>
      {otherCollection.features.length > 0 && (
        <MapGeoJSON
          data={otherCollection}
          interactive
          fillPaint={FEATURE_FILL_PAINT}
          linePaint={FEATURE_LINE_PAINT}
          fillHoverPaint={FEATURE_FILL_HOVER_PAINT}
          onClick={(e) => onSelectEntry(e.feature.properties.entryId)}
        />
      )}
      {pointCollection.features.length > 0 && (
        <MapClusterLayer<FeatureProperties>
          data={pointCollection}
          onPointClick={(feature) => onSelectEntry(feature.properties.entryId)}
        />
      )}
    </>
  );
}

/** The skeleton holds on the row path only — no stored extent, nothing complete rendered yet, no grace. The tile path never holds (its `idle` latch needs a mounted map). */
function entriesSkeletonHolds(
  tilePath: boolean,
  hasInitialBbox: boolean,
  hasRenderedOnce: boolean,
  ready: boolean,
  graceElapsed: boolean,
): boolean {
  return !tilePath && !hasInitialBbox && !hasRenderedOnce && !ready && !graceElapsed;
}

/** The "no geometry yet" empty state applies on the row path only, and only AFTER a full pass has completed — a fresh pass (e.g. the tiles→rows fallback after an edit) must not blank a mounted map; it streams in behind the chip. */
function entriesIsEmpty(
  tilePath: boolean,
  pendingSource: boolean,
  count: number,
  hasCompletedPass: boolean,
): boolean {
  return !tilePath && !pendingSource && count === 0 && hasCompletedPass;
}

/**
 * A "dumb" presentational map view of a dataset's geometries — receives data
 * as a prop rather than querying internally, matching `EntriesTable`'s own
 * pattern.
 *
 * How much the map waits depends on `initialBbox`. Without one, the skeleton
 * holds until the complete dataset has arrived (the caller's paginated query
 * finishing a full pass, then every geometry row resolving) so the viewport
 * is fitted to the full extent exactly once. With one — the server-
 * maintained `schemas.boundingBox` — the map opens immediately on that
 * extent with its dashed outline, and features stream in behind a small
 * corner spinner; once everything has landed, the viewport corrects to the
 * exact extent only if it differs (it can only be stale-wider, after
 * deletions).
 */
// oxlint-disable-next-line eslint/complexity -- ad hoc splitting risks these render paths; the real decomposition is the deferred #82 phase-2 cleanup.
export function EntriesMap({
  geometries,
  entries,
  isLoading = false,
  initialBbox,
  className,
  source,
}: {
  geometries: GeometryEntry[];
  entries: EntryDoc[];
  /** True while the caller's data is not yet a complete read (pagination pass still running). */
  isLoading?: boolean;
  /**
   * The dataset's server-maintained extent, `[minLon, minLat, maxLon, maxLat]`
   * (`schemas.boundingBox`). Lets the map render immediately on the right
   * viewport instead of waiting on the data — it's a best-effort envelope
   * (never shrinks on delete), so once everything is loaded the viewport
   * re-fits to the exact extent when that differs.
   */
  initialBbox?: [number, number, number, number];
  /** Overrides the map container's height classes (default `h-[500px]`). */
  className?: string;
  /**
   * The dataset's layer-source decision (see `lib/layer-source.ts`, issue #58
   * part 4). `{kind: "vector"}` renders the map from the tile archive via
   * `MapVectorTiles` and the row path below never mounts: geometry rows
   * aren't fetched at all, and completeness is the tile path's (`archive
   * fresh` ∧ map reached `idle` after the source was added — no Exhausted
   * pagination to wait on). `{kind: "pending"}` holds the row fetch (the
   * archive is known fresh; its URL is one round trip away). Undefined and
   * `{kind: "rows"}` keep today's row path unchanged.
   */
  source?: TileSourceDecision;
}) {
  const entryById = useMemo(
    () => new globalThis.Map(entries.map((entry) => [entry._id, entry])),
    [entries],
  );
  const vectorUrl = layerSourceUrl(source),
    tilePath = vectorUrl !== undefined,
    pendingSource = layerSourceKind(source) === "pending",
    [selectedEntryId, setSelectedEntryId] = useState<string | null>(null),
    // Tile-path completeness: latched at the map's first `idle` after the
    // vector source mounted — never re-skeletoned afterwards (a rebuild's
    // hot-swap re-adds the source in place; the map the user is looking at
    // stays mounted and keeps rendering the previous archive meanwhile).
    [tilesReady, setTilesReady] = useState(false),
    { resolvableGeometries, graceElapsed, hasRenderedOnce, rowReady } = useEntriesRowReadiness(
      geometries,
      isLoading,
    ),
    // A pending decision (fresh archive whose URL hasn't landed) holds
    // readiness too — the chip covers the map until the decision resolves
    // either way.
    ready = tilePath ? tilesReady : pendingSource ? false : rowReady;

  // The tile path never holds the skeleton: "idle" needs a MOUNTED map, and
  // the skeleton replaces the map instead of overlaying it — mounting
  // immediately (on the stored extent, or the default camera when even that
  // is missing) is the only way the latch can ever fire. A pending decision
  // resolves by itself (the metadata round trip), so its chip is safe too.
  if (
    entriesSkeletonHolds(tilePath, initialBbox !== undefined, hasRenderedOnce, ready, graceElapsed)
  ) {
    return (
      <div
        className={cn(
          "relative h-[500px] w-full overflow-hidden rounded-lg border border-border",
          className,
        )}
      >
        <Skeleton className="h-full w-full rounded-none" />
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <MapIcon className="h-4 w-4" />
          Loading map…
        </div>
      </div>
    );
  }

  if (entriesIsEmpty(tilePath, pendingSource, geometries.length, hasRenderedOnce || rowReady)) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MapIcon />
          </EmptyMedia>
          <EmptyTitle>No geometry yet</EmptyTitle>
          <EmptyDescription>Entries with geometry will appear here on the map.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const featureRows = tilePath
      ? []
      : resolvableGeometries.map(({ g, resolved }) => toFeatureRow(g, resolved)),
    collection = buildFeatureCollection<FeatureProperties>(featureRows),
    // `collection.bbox` is typed as the `geojson` package's wider `BBox` (4- or
    // 6-tuple); `computeBbox` has its own narrower `BoundingBox` (always 4)
    // return type, which is what MapLibre's `LngLatBoundsLike` actually accepts.
    // Computed from the full `geometries` array (point-like and not) so the
    // viewport still fits everything, regardless of which layer renders each row.
    bbox = computeBbox(collection),
    bounds = resolveEntriesMapBounds(ready, bbox, initialBbox),
    extentFeature = bounds ? bboxFeature(bounds) : undefined,
    // `MapGeoJSON` renders `fill`/`line` layers, which draw nothing for
    // Point/MultiPoint geometries — those go to `MapClusterLayer` instead,
    // which renders `circle` layers. Split by entryId (rather than feeding
    // `featureRows` straight into `splitPointLikeGeometries`) so each side
    // still carries its already-resolved `Geometry`.
    { pointRows } = splitPointLikeGeometries(resolvableGeometries.map(({ g }) => g)),
    pointRowIds = new Set(pointRows.map((row) => row.entryId)),
    pointCollection = buildPointFeatureCollection<FeatureProperties>(
      featureRows.filter((row) => pointRowIds.has(row.properties.entryId)),
    ),
    otherCollection = buildFeatureCollection<FeatureProperties>(
      featureRows.filter((row) => !pointRowIds.has(row.properties.entryId)),
    ),
    selectedEntry = selectedEntryId ? entryById.get(selectedEntryId) : undefined;

  return (
    <div
      className={cn(
        "relative h-[500px] w-full overflow-hidden rounded-lg border border-border",
        className,
      )}
    >
      <Map bounds={bounds} className="h-full w-full">
        {extentFeature && (
          <MapGeoJSON
            data={extentFeature}
            id="dataset-extent"
            fillPaint={false}
            linePaint={EXTENT_LINE_PAINT}
          />
        )}
        {vectorUrl !== undefined ? (
          <MapVectorTiles<{ entryId: string }>
            id="dataset-tiles"
            url={vectorUrl}
            interactive
            fillPaint={FEATURE_FILL_PAINT}
            linePaint={FEATURE_LINE_PAINT}
            fillHoverPaint={FEATURE_FILL_HOVER_PAINT}
            onIdle={() => {
              setTilesReady(true);
            }}
            onClick={(e) => {
              setSelectedEntryId(e.feature.properties.entryId);
            }}
          />
        ) : (
          <RowPathFeatureLayers
            otherCollection={otherCollection}
            pointCollection={pointCollection}
            onSelectEntry={setSelectedEntryId}
          />
        )}
      </Map>
      {!ready && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          Loading features…
        </div>
      )}
      {selectedEntry && (
        <FeatureDetailsPanel entry={selectedEntry} onClose={() => setSelectedEntryId(null)} />
      )}
    </div>
  );
}
