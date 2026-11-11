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
 * `api.cms.schemas.listSummaries`, which derived ids never appear in.
 *
 * STAGE 2 (Supabase migration, issue #201): Postgres-native datasets join
 * the decision. The split is keyed explicitly on the dataset id's origin
 * (`isPostgresDatasetId`, `#/lib/dataset-source.ts` — the one place the
 * transitional split is defined): a uuid id takes `selectPgLayerSource`
 * (freshness read off the store summary's raw archive columns, URL from the
 * signed-URL metas feed), a Convex id keeps the EXACT code path below,
 * byte-for-byte (design §14 — existing datasets render exactly as they do).
 * Both paths share the #185 pending rule (`awaitsFirstArchive`) and the
 * below-threshold skip memo (ids never collide across backends).
 */
import { isBelowThresholdSkipMemoized } from "@caden/maps/build-scheduler";
import type { FunctionReturnType } from "convex/server";
import { useSyncExternalStore } from "react";

import { isPostgresDatasetId } from "#/lib/dataset-source";
import type { api } from "#convex/_generated/api";

import type { DatasetSummary } from "./map-layers";
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

/** One schema doc's tile-relevant fields, as `api.cms.schemas.listSummaries`/`api.cms.schemas.get` return them. */
export interface TileSourceSchemaRow {
  _id: string;
  featureCount?: number;
  geometryType?: string;
  kind?: "standard" | "geospatial";
  mapTileArchiveBuiltVersion?: number;
  mapTileCacheVersion?: number;
}

/** A dataset's tile-archive metadata, or `null` with no current archive. */
export type TileArchiveMeta = FunctionReturnType<typeof api.cms.tile_archives.metas>[number];

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
 * (`mapTileArchiveBuiltVersion` present — set iff an archive ever installed —
 * and built at the current version): the only case whose decision still
 * needs the meta URL. Since #131 the summaries carry no archive storage id,
 * so built-version presence is the "archive exists" signal.
 */
function isFreshArchiveCandidate(schema: TileSourceSchemaRow): boolean {
  if (schema.mapTileArchiveBuiltVersion === undefined) return false;
  return schema.mapTileArchiveBuiltVersion === (schema.mapTileCacheVersion ?? 0);
}

/**
 * True when a large dataset has never had an archive and one is on its way:
 * the row path would double-fetch against the build (#185). Stale-but-built
 * datasets keep rows (they show the truth while the rebuild runs), and a
 * below-threshold skip means no archive is coming.
 */
export function awaitsFirstArchive(schema: TileSourceSchemaRow): boolean {
  if (schema.kind !== "geospatial" || schema.geometryType === undefined) return false;
  if (schema.mapTileArchiveBuiltVersion !== undefined) return false;
  const version = schema.mapTileCacheVersion ?? 0;
  if (version === 0 || (schema.featureCount ?? 0) < TILE_WAIT_MIN_FEATURES) return false;
  return !isBelowThresholdSkipMemoized(schema._id, version);
}

/**
 * Decides one dataset's source. Fresh-candidate rows wait on the meta URL
 * (`"pending"`) so a tile-path dataset never flashes the row path while the
 * metadata lands; every other state decides from the row alone.
 */
export function selectLayerSource(
  schema: TileSourceSchemaRow,
  meta: TileArchiveMeta | undefined,
  buildFailed = false,
): TileSourceDecision {
  if (schema.kind !== "geospatial" || schema.geometryType === undefined) return ROWS;
  // First build in flight for a large dataset: hold rows (the failure
  // fallback is the caller's `buildFailed`).
  if (!buildFailed && awaitsFirstArchive(schema)) return PENDING;
  if (!isFreshArchiveCandidate(schema)) return ROWS;
  // The meta hasn't arrived — withhold the row fetch rather than guess.
  if (meta === undefined) return PENDING;
  // `null` = the archive pointer went stale server-side (dead blob, deleted
  // schema) — rows now; the staleness machinery rebuilds/reconciles.
  if (meta === null) return ROWS;
  return { kind: "vector", url: `pmtiles://${meta.url}` };
}

/**
 * The Postgres decision (`selectLayerSource`'s PG twin): same three states,
 * same #185 hold, same failure fallback — freshness read off the summary
 * row's raw archive columns (built version, live version, and the format
 * gate the PG path carries itself — the Convex projection pre-computes its
 * format gate into `mapTileArchiveFormatCurrent`, while PG stores the raw
 * `map_tile_archive_format` this app stamps at install), and the URL state
 * rides the signed-URL metas feed with the SAME two-valued signal: undefined
 * = still loading (hold pending for a fresh candidate), null = loaded and
 * nothing servable (rows).
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

/**
 * The #185 rule for a PG row, via the SAME shared helpers the Convex path
 * uses (`awaitsFirstArchive` + the shared skip memo): map the row's fields
 * onto the decision input shape — the id spaces are disjoint, so the memo
 * keys can never collide across backends.
 */
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

/**
 * One decision input row: a component (Convex) schema summary — `_id` keyed —
 * or a Postgres dataset summary (`#/lib/store/datasets`' `DatasetSummaryRow`
 * passes structurally), `id` keyed. Which backend a row belongs to is read
 * from the id's ORIGIN (`isPostgresDatasetId`), never from shape sniffing.
 */
export type TileDecisionRow = TileSourceSchemaRow | PgTileSummaryRow;

/**
 * Decisions for a list of dataset docs, keyed by schema id. Subscribes to ONE
 * `api.cms.tile_archives.metas` query covering every geospatial dataset — the
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
 * must never enter this decision (3a, #96). Postgres summaries (uuid `id`)
 * join at stage 2 and take `selectPgLayerSource`; the Convex rows keep the
 * exact decision code below (design §14's transitional rule).
 */
export function useTileArchiveSources(
  datasets: ReadonlyArray<TileDecisionRow> | undefined,
): globalThis.Map<string, TileSourceDecision> {
  const datasetsOrEmpty: ReadonlyArray<TileDecisionRow> = datasets ?? [],
    // The origin split: partition ONCE, then each backend runs its own path.
    // The Convex half is archived with the stage-7 disconnect (issue #206):
    // no live surface passes a pre-migration schema row anymore, so
    // `convexRows` partitions empty and the `api.cms.tile_archives.metas`
    // subscription that served it is gone with the provider.
    { convexRows, pgRows } = partitionByOrigin(datasetsOrEmpty),
    pgGeospatialIds = pgRows
      .filter((row) => row.isGeospatial && row.geometryType !== null)
      .map((row) => row.id),
    pgMetas = usePgTileArchiveMetas(pgGeospatialIds),
    // Re-evaluates when a build fails or is skipped (the build-state store
    // notifies on both); a primitive snapshot keeps it referentially stable.
    failedKey = useSyncExternalStore(
      subscribeTileArchiveBuildState,
      () =>
        datasetsOrEmpty
          .map(tileDecisionIdOf)
          .filter((id) => id !== undefined && hasTileArchiveBuildFailure(id))
          .join(","),
      () => "",
    ),
    failedIds = new globalThis.Set(failedKey === "" ? [] : failedKey.split(","));
  const metaBySchemaId = new globalThis.Map<string, TileArchiveMeta>(),
    decisions = new globalThis.Map<string, TileSourceDecision>();
  for (const schema of convexRows) {
    decisions.set(
      schema._id,
      selectLayerSource(schema, metaBySchemaId.get(schema._id), failedIds.has(schema._id)),
    );
  }
  decidePgRows(pgRows, pgMetas, failedIds, decisions);
  return decisions;
}

/**
 * Partitions the decision inputs by dataset-id ORIGIN (`isPostgresDatasetId` —
 * the one split key): a row keyed `_id` is Convex, a uuid-keyed row is PG,
 * and a row that is neither (no `_id`, non-uuid id) is not a dataset either
 * backend knows — dropped (the derived-registry shape under the 3a rule).
 */
function partitionByOrigin(rows: ReadonlyArray<TileDecisionRow>): {
  convexRows: TileSourceSchemaRow[];
  pgRows: PgTileSummaryRow[];
} {
  const convexRows: TileSourceSchemaRow[] = [],
    pgRows: PgTileSummaryRow[] = [];
  for (const row of rows) {
    if ("_id" in row) {
      convexRows.push(row);
    } else if (isPostgresDatasetId(row.id)) {
      pgRows.push(row);
    }
  }
  return { convexRows, pgRows };
}

/** Fills the PG rows' decisions (kept out of the hook for the complexity budget). */
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

/** A decision row's id, whichever key its backend uses; undefined for a row with neither. */
function tileDecisionIdOf(row: TileDecisionRow): string | undefined {
  if ("_id" in row) {
    return row._id;
  }
  return row.id;
}

/** The single-dataset variant of `useTileArchiveSources` — the same decision for one schema row (either backend's summary shape), or `undefined` while the row is still loading. */
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

/**
 * This map's component geospatial datasets, in schema-id order — the ONLY
 * rows a tile decision may see: the filter drops any render id without a
 * geospatial dataset behind it here, before `useTileArchiveSources` would
 * subscribe archive metadata for it.
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
