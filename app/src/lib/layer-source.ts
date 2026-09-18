/**
 * Layer-source selection (issue #58 part 4): decides, per geospatial dataset,
 * whether its map layers render from the dataset's tile archive (vector
 * tiles via MapLibre's `pmtiles://` protocol) or from today's row-based
 * geometry path (`useGeometriesBySchemas` + loaders).
 *
 * The decision is "vector" only when the archive is present AND fresh —
 * `meta.version` (the built-at snapshot, see part 3's amendment) matches the
 * schema's live `mapTileCacheVersion`. Everything else renders rows:
 * below-threshold datasets (no archive will ever exist), datasets whose
 * archive hasn't landed yet (first view before part 3's first rebuild), and
 * datasets that went STALE after an edit (the authoritative self-healing
 * fallback — rows show the truth while the background rebuild runs, then the
 * source hot-swaps to the fresh archive). The threshold itself is NOT
 * re-derived here: an archive's existence already implies the dataset was
 * above `MAP_TILE_ARCHIVE_MIN_BYTES` when the worker built it (small datasets
 * are skipped before upload), so "archive present ∧ fresh" is the whole test.
 */
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import { api } from "#convex/_generated/api";

/** One schema doc, as `api.schemas.list`/`api.schemas.get` return it. */
export interface TileSourceSchemaRow {
  _id: string;
  geometryType?: string;
  kind?: "standard" | "geospatial";
  mapTileArchiveBuiltVersion?: number;
  mapTileArchiveStorageId?: string;
  mapTileCacheVersion?: number;
}

/** A dataset's tile-archive metadata, or `null` with no current archive. */
export type TileArchiveMeta = FunctionReturnType<typeof api.tile_archives.metas>[number];

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
 * True when the schema row alone proves a fresh archive is installed
 * (`storageId` present, built-at version current) — the only case whose
 * decision still needs the meta URL.
 */
function isFreshArchiveCandidate(schema: TileSourceSchemaRow): boolean {
  if (schema.mapTileArchiveStorageId === undefined) return false;
  if (schema.mapTileArchiveBuiltVersion === undefined) return false;
  return schema.mapTileArchiveBuiltVersion === (schema.mapTileCacheVersion ?? 0);
}

/**
 * Decides one dataset's source. Fresh-candidate rows wait on the meta URL
 * (`"pending"`) so a tile-path dataset never flashes the row path while the
 * metadata lands; every other state decides from the row alone.
 */
export function selectLayerSource(
  schema: TileSourceSchemaRow,
  meta: TileArchiveMeta | undefined,
): TileSourceDecision {
  if (schema.kind !== "geospatial" || schema.geometryType === undefined) return ROWS;
  if (!isFreshArchiveCandidate(schema)) return ROWS;
  // The meta hasn't arrived — withhold the row fetch rather than guess.
  if (meta === undefined) return PENDING;
  // `null` = the archive pointer went stale server-side (dead blob, deleted
  // schema) — rows now; the staleness machinery rebuilds/reconciles.
  if (meta === null) return ROWS;
  return { kind: "vector", url: `pmtiles://${meta.url}` };
}

/**
 * Decisions for a list of dataset docs, keyed by schema id. Subscribes to ONE
 * `api.tile_archives.metas` query covering every geospatial dataset — the
 * hook-rules-safe fan-out (one reactive subscription for N datasets, instead
 * of an illegal per-id `useQuery` loop). `undefined`/empty lists subscribe to
 * nothing and return an empty map.
 *
 * Rows not in `datasets` never appear in the result. Decisions re-evaluate
 * reactively: a version bump flips the dataset to rows (the rebuild is
 * scheduled by the root manager), the completed install flips it back.
 */
export function useTileArchiveSources(
  datasets: TileSourceSchemaRow[] | undefined,
): globalThis.Map<string, TileSourceDecision> {
  const datasetsOrEmpty = datasets ?? [],
    geospatialIds = datasetsOrEmpty
      .filter((schema) => schema.kind === "geospatial" && schema.geometryType !== undefined)
      .map((schema) => schema._id),
    metas = useQuery(
      api.tile_archives.metas,
      geospatialIds.length > 0 ? { schemaIds: geospatialIds } : "skip",
    ),
    metaBySchemaId = new globalThis.Map<string, TileArchiveMeta>();
  if (metas !== undefined) {
    for (const [index, schemaId] of geospatialIds.entries()) {
      const meta = metas[index];
      if (meta !== undefined) {
        metaBySchemaId.set(schemaId, meta);
      }
    }
  }
  const decisions = new globalThis.Map<string, TileSourceDecision>();
  for (const schema of datasetsOrEmpty) {
    decisions.set(schema._id, selectLayerSource(schema, metaBySchemaId.get(schema._id)));
  }
  return decisions;
}

/** The single-dataset variant of `useTileArchiveSources` — the same decision for one schema row (or `undefined` while the row is still loading). */
export function useTileArchiveSource(
  schema: TileSourceSchemaRow | null | undefined,
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

/** Decides rendering per schema id from its dataset list and decisions. */
export function splitSchemaIdsByDecision(
  schemaIds: string[],
  decisions: globalThis.Map<string, TileSourceDecision>,
): LayerSourceSplit {
  const rowSchemaIds: string[] = [],
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
      rowSchemaIds.push(schemaId);
    } else {
      sourcesPending = true;
    }
  }
  return { rowSchemaIds, sourcesPending, tileSources };
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
