/**
 * The Postgres side of the tile-archive pipeline (stage 2, issue #201) —
 * pure state and feeds, no React: the archive-FORMAT constant this app
 * stamps at install and compares at read, the tile-relevant projection of a
 * PG dataset summary row, the staleness check (the scheduler's Convex-tested
 * logic, fed the raw format column), the archive-pointer → signed-URL feed
 * the layer-source decision and the OPFS pin observe, and the upload-path
 * convention. The reactive hooks that surface these live in
 * `pg-tile-archives-react.tsx` (kept separate so the BUILD WORKER can import
 * the core without pulling React into the worker bundle — the same split
 * `dataset-rows.ts` / `dataset-rows-react.tsx` uses).
 *
 * The Convex twin of every concept here lives in `layer-source.ts` /
 * `tile-archive.ts` / `tile-archive-cache.ts` and keeps serving the frozen
 * Convex datasets byte-for-byte (design §14): which backend a decision
 * covers is keyed explicitly on the dataset id's origin
 * (`isPostgresDatasetId`, `#/lib/dataset-source.ts`) — never re-derived.
 */

import { isTileArchiveStale } from "@caden/maps/build-scheduler";

import { clientOf, type StoreOptions } from "#/lib/store/client";
import type { DatasetSummaryRow } from "#/lib/store/datasets";
import { createTileArchiveUrl, tileArchivePointers } from "#/lib/store/geometries";

/**
 * The PMTiles layout generation this app's builder produces (issue #125's
 * archive-FORMAT gate): installed archives whose format differs read as "no
 * archive" (rows + a rebuild), never as servable tiles.
 *
 * KEEP IN SYNC with `MAP_TILE_ARCHIVE_FORMAT` in
 * `packages/json-cms/src/component/internal/tileArchive.ts` (= 2, the
 * run-length-gap fix). The Convex side computes its format gate NEXT TO that
 * constant (the summary projection's derived `mapTileArchiveFormatCurrent` —
 * a drifted low mirror would loop rebuilds forever); the PG side is its own
 * closed loop instead: this constant is BOTH what the install RPC stamps
 * (`p_format`) and what the decision compares, so a PG archive can only ever
 * carry a format this file knows — the drift the #125 rule guards against
 * cannot occur. Do not lower it to "simplify" a mismatch away.
 */
export const MAP_TILE_ARCHIVE_FORMAT = 2;

/**
 * The tile-relevant fields of a Postgres dataset summary row
 * (`store/datasets`' `DatasetSummaryRow` — the full row passes
 * structurally). Deliberately the SAME field names the store exposes, so
 * callers feed summary rows in without reshaping.
 */
export type PgTileSummaryRow = Pick<
  DatasetSummaryRow,
  | "featureCount"
  | "geometryType"
  | "id"
  | "isGeospatial"
  | "mapTileArchiveBuiltVersion"
  | "mapTileArchiveFormat"
  | "mapTileCacheVersion"
>;

/** True when the row is a tile candidate at all (geospatial with a geometry type). */
export function isPgTileCandidate(row: PgTileSummaryRow): boolean {
  return row.isGeospatial && row.geometryType !== null;
}

/**
 * The PG staleness check — the scheduler's `isTileArchiveStale` (skip-memo,
 * first-build, format gate, stale-on-view in its tested order) fed the RAW
 * `map_tile_archive_format` column as the derived `mapTileArchiveFormatCurrent`
 * boolean the Convex projection computes server-side. PG has no legacy
 * absent-flag era (stage 2 installs start fresh), so the flag is always a
 * boolean here.
 */
export function isPgTileArchiveStale(row: PgTileSummaryRow): boolean {
  return isTileArchiveStale(
    {
      _id: row.id,
      geometryType: row.geometryType === null ? undefined : row.geometryType,
      kind: row.isGeospatial ? "geospatial" : "standard",
      mapTileArchiveBuiltVersion: row.mapTileArchiveBuiltVersion ?? undefined,
      mapTileArchiveFormatCurrent: row.mapTileArchiveFormat === MAP_TILE_ARCHIVE_FORMAT,
      mapTileCacheVersion: row.mapTileCacheVersion,
    },
    row.mapTileCacheVersion,
  );
}

/**
 * True when the row alone proves a CURRENT-format archive is installed at the
 * live version — the PG read of "fresh archive candidate" (the Convex check
 * compares built versions only, because its META query applies the format
 * gate by returning null). The decision function in `layer-source.ts` still
 * withholds `vector` until the signed URL lands.
 */
export function isPgFreshArchiveCandidate(row: PgTileSummaryRow): boolean {
  if (row.mapTileArchiveBuiltVersion === null) return false;
  if (row.mapTileArchiveBuiltVersion !== row.mapTileCacheVersion) return false;
  return row.mapTileArchiveFormat === MAP_TILE_ARCHIVE_FORMAT;
}

/**
 * Storage path convention for an archive upload attempt: unique per attempt
 * (a random token) so two concurrent builds at the same version never PUT to
 * the same object — the losing install self-discards at the CAS and its
 * object is simply never claimed (a stage-later cleanup can sweep orphans;
 * the Convex flow deleted the incoming blob, an ability the path-based RPC
 * does not carry — recorded as a known difference).
 */
export function pgTileArchiveUploadPath(datasetId: string, version: number): string {
  return `${datasetId}/v${version}-${crypto.randomUUID()}.pmtiles`;
}

/**
 * One PG dataset's servable archive, as the layer-source decision and the
 * OPFS pin observe it — the `api.cms.tile_archives.metas` analogue. The
 * feed only emits datasets whose installed archive is CURRENT-FORMAT and
 * built at the live version: a wrong-format or stale pointer reads as
 * absent (rows + rebuild), exactly like the Convex metas query returning
 * null.
 */
export interface PgTileArchiveMeta {
  datasetId: string;
  /** Signed range-read URL (24 h TTL — the §16 pick, see the store constant). */
  url: string;
  version: number;
}

/**
 * Signs every current archive pointer for the given datasets (design §6:
 * private bucket, short-lived signed URLs). One pointer select, then
 * parallel signing on the given client (default: the shared browser
 * client); a dataset whose signing FAILS is omitted (rows until the next
 * observation) instead of failing the whole feed. Version/filter semantics
 * above.
 */
export async function pgTileArchiveMetasOf(
  datasetIds: ReadonlyArray<string>,
  options?: StoreOptions,
): Promise<PgTileArchiveMeta[]> {
  const pointers = await tileArchivePointers({ datasetIds }, options);
  const client = clientOf(options);
  const metas = await Promise.all(
    pointers.map(async (pointer): Promise<PgTileArchiveMeta | null> => {
      if (pointer.mapTileArchivePath === null) return null;
      if (pointer.mapTileArchiveBuiltVersion === null) return null;
      if (pointer.mapTileArchiveBuiltVersion !== pointer.mapTileCacheVersion) return null;
      if (pointer.mapTileArchiveFormat !== MAP_TILE_ARCHIVE_FORMAT) return null;
      try {
        const url = await createTileArchiveUrl(client, pointer.mapTileArchivePath);
        return { datasetId: pointer.id, url, version: pointer.mapTileArchiveBuiltVersion };
      } catch {
        // Unsignable (missing object, signing denied): the dataset reads rows.
        return null;
      }
    }),
  );
  return metas.filter((meta) => meta !== null);
}
