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
 *
 * Derived datasets (roadmap 3a, #96) are ROWS by explicit rule, never by
 * accident: a registry id has no `schemas` row — no boundingBox, no
 * `mapTileArchive*` fields, nothing for `selectLayerSource` to answer from —
 * and the tile decision only ever sees the component dataset rows
 * `geospatialDatasetsFor` passes it. `splitSchemaIdsByDecision` takes the
 * derived render ids explicitly and files them under `derivedRowIds` (the
 * pre-3a behavior silently dropped any id without a decision); the tile
 * REBUILD side is structurally out too — the rebuild manager subscribes
 * `api.schemas.listSummaries`, which derived ids never appear in.
 */
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

import type { DatasetSummary } from "#/lib/map-layers";
import { api } from "#convex/_generated/api";

/** One schema doc's tile-relevant fields, as `api.schemas.listSummaries`/`api.schemas.get` return them. */
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
 *
 * Inputs are component schema rows only (pass them through
 * `geospatialDatasetsFor`) — a derived registry id has no schemas row and
 * must never enter this decision (3a, #96).
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
  /**
   * Derived datasets on the row path by RULE (3a, #96): their geometry rides
   * the bottom source dataset of their spec chain, so these ids key
   * rendering/visibility while their SOURCE ids key the geometry
   * subscription (the caller re-keys via `renderTargetsForDerivedLayers`).
   * Never a tile candidate: no schemas row, no archive, ever.
   */
  derivedRowIds: string[];
  /** Datasets rendering from their fresh tile archive (`pmtiles://`). */
  tileSources: Array<{ schemaId: string; url: string }>;
  /** True while any id's decision is still resolving — hold rather than render either path. */
  sourcesPending: boolean;
}

/**
 * Decides rendering per schema id from its dataset list and decisions.
 * `derivedRowIds` are the render ids `expandLayerDatasets` contributed for
 * derived layers (3a): they take the row path explicitly instead of the old
 * silent drop (any id without a decision was skipped), and their geometry
 * subscription keys are the caller's job (the bottom source ids).
 */
export function splitSchemaIdsByDecision(
  schemaIds: string[],
  decisions: globalThis.Map<string, TileSourceDecision>,
  derivedRowIds: readonly string[] = [],
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
  return { derivedRowIds: [...derivedRowIds], rowSchemaIds: rows, sourcesPending, tileSources };
}

/**
 * This map's component geospatial datasets, in schema-id order — the ONLY
 * rows a tile decision may see (the explicit 3a rule, #96): a derived
 * dataset's registry id has no schemas row, so it can never be mistaken for
 * a tile candidate — the filter drops it here, before
 * `useTileArchiveSources` would subscribe archive metadata for it. The map
 * page passes every render id (datasets and derived layers together) and
 * only component rows come back.
 */
export function geospatialDatasetsFor(
  schemaIds: readonly string[],
  datasets: readonly DatasetSummary[] | undefined,
): TileSourceSchemaRow[] {
  if (datasets === undefined) {
    return [];
  }
  const byId = new globalThis.Map(datasets.map((dataset) => [dataset._id, dataset]));
  return schemaIds.flatMap((schemaId) => {
    const dataset = byId.get(schemaId);
    return dataset !== undefined && dataset.kind === "geospatial" ? [dataset] : [];
  });
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
