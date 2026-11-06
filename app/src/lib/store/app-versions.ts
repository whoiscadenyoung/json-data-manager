import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * The app-versions store (issue #259 — the project-centric train's phase 5;
 * ADR 0021) — the append-only frozen publish chain over `public.app_versions`
 * (migration 0022), mirroring `layer_versions`/`dataset_versions`: rows never
 * mutate, newest per app is the head.
 *
 * The frozen `definition` (the shape {@link AppVersionDefinition} types):
 *   - title/description + the app's pages jsonb verbatim (map widgets keep
 *     their `mapId` — the widget resolves its snapshot at render);
 *   - `datasetPins` — per referenced dataset, the head version id + ref +
 *     the frozen title/schema/geometry facts; a dataset with no chain yet
 *     pins nulls (honest — the widget renders "unavailable" until the
 *     dataset publishes);
 *   - `mapSnapshots` — per referenced map, the frozen meta + placements as
 *     `{order, visible, versionId}`;
 *   - `layerVersions` — the flattened set of referenced layer_versions rows
 *     (definition + resolved `{datasetId, versionId, ref}` dataset pin +
 *     frozenChildren), so the published render reads ONLY this snapshot and
 *     the immutable `version_entries`.
 *
 * Inserts happen through the publish walk (`#/features/publishing/lib/pg-
 * app-publish`), not here — the store is reads only, exactly the shape the
 * RLS grants (append-only, no update/delete policies).
 *
 * NOTE: narrow local interfaces typed from the migration 0022 DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/** One frozen dataset pin: what a published widget reads instead of the live dataset. */
export interface AppDatasetPin {
  datasetId: string;
  /** The pinned dataset_versions row; null = the dataset had no published version at freeze. */
  versionId: string | null;
  ref: string | null;
  title: string | null;
  jsonSchema: unknown;
  isGeospatial: boolean;
  geometryType: string | null;
  /** The frozen expand-only bbox envelope (`datasets.bbox` at freeze). */
  bbox: unknown;
}

/** One frozen placement: a pointer into the snapshot's layerVersions list. */
export interface AppMapSnapshotPlacement {
  order: number;
  visible: boolean;
  /** The layer_versions row id — resolve it in `layerVersions`. */
  versionId: string;
}

/** One frozen map: what a published map widget renders instead of the live map. */
export interface AppMapSnapshot {
  mapId: string;
  name: string;
  /** The saved camera at freeze (bounds + zoom); null = the render fits the data. */
  viewport: unknown;
  basemap: string | null;
  placements: AppMapSnapshotPlacement[];
}

/** One referenced layer_versions row, flattened into the snapshot. */
export interface AppSnapshotLayerVersion {
  versionId: string;
  layerId: string;
  kind: "data" | "group";
  /** The frozen name/style/filter/labels/popup/opacity/visible at publish. */
  definition: Record<string, unknown>;
  /** Data kind: the resolved dataset ref at publish; null on groups. */
  dataset: { datasetId: string; versionId: string; ref: string | null } | null;
  /** Group versions: the frozen children (child version ids resolve in this same list). */
  frozenChildren: Array<{
    childKind: "owned" | "linked";
    childLayerId: string;
    versionId: string;
  }> | null;
}

/** The whole frozen publish snapshot (migration 0022's `definition` jsonb). */
export interface AppVersionDefinition {
  title: string;
  description: string | null;
  pages: unknown;
  datasetPins: AppDatasetPin[];
  mapSnapshots: AppMapSnapshot[];
  layerVersions: AppSnapshotLayerVersion[];
}

/** One app_versions row, as every reader gets it (migration 0022's DDL). */
export interface AppVersionRow {
  id: string;
  appId: string;
  versionLabel: string;
  definition: AppVersionDefinition;
  createdAt: string;
}

const VERSION_SELECT = "id,appId:app_id,versionLabel:version_label,definition,createdAt:created_at";

/** The version-chain width (the versions store's read cap — an app republishes rarely). */
export const APP_VERSIONS_READ_LIMIT = 200;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The app's published versions, newest first (the head is index 0). */
export async function list(
  args: { appId: string },
  options?: StoreOptions,
): Promise<AppVersionRow[]> {
  return await queryRows<AppVersionRow>(
    clientOf(options)
      .from("app_versions")
      .select(VERSION_SELECT)
      .eq("app_id", args.appId)
      .order("created_at", { ascending: false })
      .limit(APP_VERSIONS_READ_LIMIT),
  );
}

/** The app's head version, or null when the app has never been published. */
export async function head(
  args: { appId: string },
  options?: StoreOptions,
): Promise<AppVersionRow | null> {
  return await queryRow<AppVersionRow>(
    clientOf(options)
      .from("app_versions")
      .select(VERSION_SELECT)
      .eq("app_id", args.appId)
      .order("created_at", { ascending: false })
      .limit(1),
  );
}

// ---------------------------------------------------------------------------
// TanStack Query options
// ---------------------------------------------------------------------------

export function listQueryOptions(args: { appId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:appVersions", "list", args],
    queryFn: async () => await list(args, options),
  });
}

export function headQueryOptions(args: { appId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:appVersions", "head", args],
    queryFn: async () => await head(args, options),
  });
}

/** Inserts one frozen version (the publish walk's write; `version_label` is the walk's computed label). Returns the new row. */
export async function insert(
  args: { appId: string; versionLabel: string; definition: AppVersionDefinition },
  options?: StoreOptions,
): Promise<AppVersionRow | null> {
  return await queryRow<AppVersionRow>(
    clientOf(options)
      .from("app_versions")
      .insert({
        app_id: args.appId,
        definition: args.definition,
        version_label: args.versionLabel,
      })
      .select(VERSION_SELECT)
      .single(),
  );
}
