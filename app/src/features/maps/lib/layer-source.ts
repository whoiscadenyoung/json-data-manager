/**
 * Layer-source selection (issue #58 part 4): decides, per geospatial dataset,
 * whether its map layers render from the dataset's tile archive (vector
 * tiles via MapLibre's `pmtiles://` protocol) or from the row-based
 * geometry path.
 *
 * The decision is "vector" only when the archive is present AND fresh — the
 * built-at version matches the dataset's live `mapTileCacheVersion`.
 * Everything else renders rows: below-threshold datasets (no archive will
 * ever exist), datasets whose archive hasn't landed yet, and datasets that
 * went STALE after an edit (rows show the truth while the background rebuild
 * runs, then the source hot-swaps to the fresh archive). The threshold
 * itself is NOT re-derived here: an archive's existence already implies the
 * dataset was above `MAP_TILE_ARCHIVE_MIN_BYTES` when the worker built it.
 *
 * Freshness is read off the store summary's raw archive columns and the URL
 * comes from the signed-URL metas feed. The #185 pending rule
 * (`awaitsFirstArchive`) holds large never-built datasets off the row path
 * while their first archive is on its way, and a build failure or
 * below-threshold skip releases them to rows.
 */
import { isBelowThresholdSkipMemoized } from "@caden/maps/build-scheduler";
import { useSyncExternalStore } from "react";

import type { PgTileArchiveMeta, PgTileSummaryRow } from "./pg-tile-archives";
import { isPgFreshArchiveCandidate } from "./pg-tile-archives";
import { usePgTileArchiveMetas } from "./pg-tile-archives-react";
import { hasTileArchiveBuildFailure, subscribeTileArchiveBuildState } from "./tile-archive";

/**
 * Feature count at which a dataset with no archive yet waits for its first
 * tile build instead of streaming rows (#185). Above it the row path and the
 * build worker would fetch the same rows twice (20k points: ~32 s cold open,
 * ~500 MB heap vs ~1.3 s on tiles). Below it, rows are cheap and unchanged.
 */
export const TILE_WAIT_MIN_FEATURES = 5000;

/** The tile-relevant fields of one dataset, for the #185 pending rule. */
interface TileSourceSchemaRow {
  _id: string;
  featureCount?: number;
  geometryType?: string;
  kind?: "standard" | "geospatial";
  mapTileArchiveBuiltVersion?: number;
  mapTileCacheVersion?: number;
}

/** How one dataset's layers are served right now. */
export type TileSourceDecision =
  /** The archive is present and fresh — render from `url` (`pmtiles://…`). */
  | { kind: "vector"; url: string }
  /** Render today's row path. */
  | { kind: "rows" }
  /** A fresh archive exists but its metadata (the URL) hasn't arrived yet — hold, don't start the row fetch. */
  | { kind: "pending" };

/** A dataset with no archive — never a tile candidate (also covers standard datasets). */
const ROWS: TileSourceDecision = { kind: "rows" };
/** Fresh archive known to exist; its URL is one round trip away. */
const PENDING: TileSourceDecision = { kind: "pending" };

/**
 * True when a large dataset has never had an archive and one is on its way:
 * the row path would double-fetch against the build (#185). Stale-but-built
 * datasets keep rows (they show the truth while the rebuild runs), and a
 * below-threshold skip means no archive is coming.
 */
function awaitsFirstArchive(schema: TileSourceSchemaRow): boolean {
  if (schema.kind !== "geospatial" || schema.geometryType === undefined) return false;
  if (schema.mapTileArchiveBuiltVersion !== undefined) return false;
  const version = schema.mapTileCacheVersion ?? 0;
  if (version === 0 || (schema.featureCount ?? 0) < TILE_WAIT_MIN_FEATURES) return false;
  return !isBelowThresholdSkipMemoized(schema._id, version);
}

/**
 * One dataset's source decision: vector, rows, or pending. Freshness is read
 * off the summary row's raw archive columns (built version, live version and
 * the `map_tile_archive_format` this app stamps at install), and the URL
 * state rides the signed-URL metas feed with a two-valued signal: undefined
 * = still loading (hold pending for a fresh candidate), null = loaded and
 * nothing servable (rows). A large never-built dataset holds pending (#185)
 * unless its build failed.
 */
export function selectPgLayerSource(
  row: PgTileSummaryRow,
  archive: PgTileArchiveMetaView,
  buildFailed = false,
): TileSourceDecision {
  if (!row.isGeospatial || row.geometryType === null) return ROWS;
  if (!buildFailed && pgAwaitsFirstArchive(row)) return PENDING;
  if (!isPgFreshArchiveCandidate(row)) return ROWS;
  if (archive === undefined) return PENDING;
  if (archive === null) return ROWS;
  return { kind: "vector", url: `pmtiles://${archive.url}` };
}

/** The #185 rule for a summary row: map its fields onto the decision input shape. */
function pgAwaitsFirstArchive(row: PgTileSummaryRow): boolean {
  return awaitsFirstArchive({
    _id: row.id,
    featureCount: row.featureCount,
    geometryType: row.geometryType === null ? undefined : row.geometryType,
    kind: row.isGeospatial ? "geospatial" : "standard",
    mapTileArchiveBuiltVersion: row.mapTileArchiveBuiltVersion ?? undefined,
    mapTileCacheVersion: row.mapTileCacheVersion,
  });
}

/** The signed-URL state for one PG dataset: loading (undefined) / none (null) / servable. */
export type PgTileArchiveMetaView = PgTileArchiveMeta | null | undefined;

/** One decision input row: a dataset summary from the store. */
export type TileDecisionRow = PgTileSummaryRow;

/**
 * Decisions for a list of dataset summaries, keyed by dataset id. Subscribes
 * to ONE signed-URL metas feed covering every geospatial dataset — the
 * hook-rules-safe fan-out (one reactive subscription for N datasets, instead
 * of an illegal per-id loop). `undefined`/empty lists subscribe to nothing
 * and return an empty map.
 *
 * Rows not in `datasets` never appear in the result. Decisions re-evaluate
 * reactively: a version bump flips the dataset to rows (the rebuild is
 * scheduled by the root manager), the completed install flips it back.
 */
export function useTileArchiveSources(
  datasets: ReadonlyArray<TileDecisionRow> | undefined,
): globalThis.Map<string, TileSourceDecision> {
  const rows = datasets ?? [],
    geospatialIds = rows
      .filter((row) => row.isGeospatial && row.geometryType !== null)
      .map((row) => row.id),
    metas = usePgTileArchiveMetas(geospatialIds),
    // Re-evaluates when a build fails or is skipped (the build-state store
    // notifies on both); a primitive snapshot keeps it referentially stable.
    failedKey = useSyncExternalStore(
      subscribeTileArchiveBuildState,
      () =>
        rows
          .map((row) => row.id)
          .filter((id) => hasTileArchiveBuildFailure(id))
          .join(","),
      () => "",
    ),
    failedIds = new globalThis.Set(failedKey === "" ? [] : failedKey.split(",")),
    decisions = new globalThis.Map<string, TileSourceDecision>();
  decidePgRows(rows, metas, failedIds, decisions);
  return decisions;
}

/** Fills the rows' decisions (kept out of the hook for the complexity budget). */
function decidePgRows(
  pgRows: ReadonlyArray<PgTileSummaryRow>,
  pgMetas: globalThis.Map<string, PgTileArchiveMeta> | undefined,
  failedIds: globalThis.Set<string>,
  decisions: globalThis.Map<string, TileSourceDecision>,
): void {
  for (const row of pgRows) {
    const archive: PgTileArchiveMetaView =
      pgMetas === undefined ? undefined : (pgMetas.get(row.id) ?? null);
    decisions.set(row.id, selectPgLayerSource(row, archive, failedIds.has(row.id)));
  }
}

/** The single-dataset variant of `useTileArchiveSources` — the same decision for one summary row, or `undefined` while the row is still loading. */
export function useTileArchiveSource(
  schema: TileDecisionRow | null | undefined,
  schemaId: string,
): TileSourceDecision | undefined {
  return useTileArchiveSources(schema === null || schema === undefined ? [] : [schema]).get(
    schemaId,
  );
}

/** Where a set of datasets' rendering goes, once their decisions are known. */
export interface LayerSourceSplit {
  /** Datasets the row path serves (paginated geometry rows). */
  rowSchemaIds: string[];
  /** Datasets rendering from their fresh tile archive (`pmtiles://`). */
  tileSources: Array<{ schemaId: string; url: string }>;
  /** True while any id's decision is still resolving — hold rather than render either path. */
  sourcesPending: boolean;
}

/**
 * Decides rendering per schema id from its dataset list and decisions. An id
 * with no decision (not geospatial, or still resolving) contributes nothing
 * to the rows/tiles lists — `sourcesPending` distinguishes "hold" from
 * "skip".
 */
export function splitSchemaIdsByDecision(
  schemaIds: string[],
  decisions: globalThis.Map<string, TileSourceDecision>,
): LayerSourceSplit {
  const rows: string[] = [],
    tileSources: Array<{ schemaId: string; url: string }> = [];
  let sourcesPending = false;
  for (const schemaId of schemaIds) {
    const decision = decisions.get(schemaId);
    if (decision === undefined) {
      continue;
    }
    if (decision.kind === "vector") {
      tileSources.push({ schemaId, url: decision.url });
    } else if (decision.kind === "rows") {
      rows.push(schemaId);
    } else {
      sourcesPending = true;
    }
  }
  return { rowSchemaIds: rows, sourcesPending, tileSources };
}

/** The coarse kind of one dataset's rendering, for pages that branch on it. `"none"` = the dataset isn't geospatial (no decision exists). */
export type LayerSourceKind = TileSourceDecision["kind"] | "none";

export function layerSourceKind(decision: TileSourceDecision | undefined): LayerSourceKind {
  return decision === undefined ? "none" : decision.kind;
}

/** The fresh archive's `pmtiles://` URL, or `undefined` when the dataset isn't on the tile path. */
export function layerSourceUrl(decision: TileSourceDecision | undefined): string | undefined {
  if (decision === undefined || decision.kind !== "vector") {
    return undefined;
  }
  return decision.url;
}
