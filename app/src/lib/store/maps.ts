import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * The maps store (design doc §8.1) — the PG counterpart of today's
 * `api.cms.maps.*`: `list` / `get` / `create` / `update` / `remove` /
 * `listLayers` / `addLayer` / `removeLayer` / `setLayerVisibility` /
 * `moveLayer` / `listOverrides` / `setMapLayerOverride`, over the catalog
 * tables `public.maps`, `public.map_layers`, `public.map_layer_overrides`
 * (DDL §3.4).
 *
 * Behavior parity notes (each traces to the Convex-era surface the maps
 * workspace rode, `app/convex/cms/maps.ts`):
 *   - `addLayer` appends at the END of the draw order (`order` = max + 1 —
 *     layers draw in list order, top of the panel first).
 *   - `removeLayer`/`remove` are plain deletes: the FKs cascade
 *     (map → layers → overrides, §3.4 — "deleted-with-parent cascades
 *     replace the component's explicit deleteSchema/deleteGroup/
 *     deleteCollection cleanup walks"), so a map's layers and a layer's
 *     overrides never dangle.
 *   - `moveLayer("up"|"down")` swaps the layer's `order` with its adjacent
 *     neighbor's (the panel's up/down semantics). PostgREST statements are
 *     single-statement, so the swap is two updates where the Convex mutation
 *     was one transaction; a crash between them can leave two layers with
 *     the same `order` — deterministic and harmless, because every read
 *     tie-breaks on `id` (no unique constraint exists on `(map_id, order)`,
 *     per the DDL's "gaps allowed after removal").
 *   - `setMapLayerOverride` keeps the #53 semantics: HIDING a child writes a
 *     `{visible: false}` row (upsert on the unique `(layer_id, child_key)`);
 *     SHOWING clears any override row (back to the default visible). An
 *     override row that survives its layer's child leaves the read as an
 *     inert entry (the component's dangling-target tolerance, §3.4).
 *
 * Transactions: the create-and-add flow (`AddToMapSheet`'s "create & add")
 * is two calls where the Convex mutation was one; a crash between them
 * leaves an empty map — the user adds the layer again from the workspace.
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL (§3.4), not
 * the generated `database.types.ts` (see `./client`).
 */

/** One saved map, as every reader of `maps` gets it (DDL §3.4). */
export interface MapRow {
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** One layer of a saved map, in the DDL's shape (`targetId` is uuid-as-text, §3.4). */
export interface MapLayerRow {
  id: string;
  mapId: string;
  /** Draw/list position; written contiguously, gaps allowed after removal (§3.4). */
  order: number;
  targetType: "collection" | "group" | "dataset" | "derived";
  targetId: string;
  visible: boolean;
}

/** One child-visibility override of a layer (`childKey` is `'group:<id>'` | `'dataset:<id>'`, §3.4). */
export interface MapLayerOverrideRow {
  id: string;
  layerId: string;
  childKey: string;
  visible: boolean;
}

const MAP_SELECT =
    "id,name,description,createdBy:created_by,createdAt:created_at,updatedAt:updated_at",
  LAYER_SELECT = "id,mapId:map_id,order,targetType:target_type,targetId:target_id,visible",
  OVERRIDE_SELECT = "id,layerId:layer_id,childKey:child_key,visible";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The saved maps, newest first (the maps index's list). */
export async function list(options?: StoreOptions): Promise<MapRow[]> {
  return await queryRows<MapRow>(
    clientOf(options)
      .from("maps")
      .select(MAP_SELECT)
      .order("created_at", { ascending: false })
      .limit(DEFAULT_MAPS_LIMIT),
  );
}

/** The maps list width when a caller doesn't pin one (the Convex `list` call sites all passed 500). */
export const DEFAULT_MAPS_LIMIT = 500;

/** One saved map by id, or null when RLS hides it (the invisible-row-reads-as-not-found rule). */
export async function get(args: { mapId: string }, options?: StoreOptions): Promise<MapRow | null> {
  return await queryRow<MapRow>(
    clientOf(options).from("maps").select(MAP_SELECT).eq("id", args.mapId).limit(1),
  );
}

/** The map's layers in draw order (`order` asc, `id` tie-break — see `moveLayer`). */
export async function listLayers(
  args: { mapId: string },
  options?: StoreOptions,
): Promise<MapLayerRow[]> {
  return await queryRows<MapLayerRow>(
    clientOf(options)
      .from("map_layers")
      .select(LAYER_SELECT)
      .eq("map_id", args.mapId)
      .order("order", { ascending: true })
      .order("id", { ascending: true })
      .limit(DEFAULT_LAYERS_LIMIT),
  );
}

/** The layer-list width when a caller doesn't pin one (the Convex call sites all passed 500). */
export const DEFAULT_LAYERS_LIMIT = 500;

/**
 * Every PG map's layers in one read — the maps index's per-map layer counts
 * and the add-to-map sheet's "Added" badges (the Convex surface's
 * `listLayers({limit: 500})` all-maps read; per-map counts are computed
 * client-side there too). Draw order is meaningless across maps, so this
 * orders only by id for read stability.
 */
export async function listAllLayers(options?: StoreOptions): Promise<MapLayerRow[]> {
  return await queryRows<MapLayerRow>(
    clientOf(options)
      .from("map_layers")
      .select(LAYER_SELECT)
      .order("id", { ascending: true })
      .limit(DEFAULT_LAYERS_LIMIT),
  );
}

/** `listAllLayers` as TanStack Query options. */
export function listAllLayersQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "listAllLayers"],
    queryFn: async () => await listAllLayers(options),
  });
}

/**
 * Every child-visibility override of THIS map's layers — the issue #53
 * shape (the wrapper reads through the map's own layers, not every map's
 * overrides). PostgREST resource embedding with `!inner` filters to layers
 * of the map; the embed key is the TABLE name (`map_layers` — PostgREST
 * names relationships after the table, verified against the local stack's
 * REST endpoint), and the embedded parent is stripped by the mapper.
 */
export async function listOverrides(
  args: { mapId: string },
  options?: StoreOptions,
): Promise<MapLayerOverrideRow[]> {
  const rows = await queryRows<MapLayerOverrideRow & { map_layers: unknown }>(
    clientOf(options)
      .from("map_layer_overrides")
      .select(`${OVERRIDE_SELECT},map_layers!inner(map_id)`)
      .eq("map_layers.map_id", args.mapId)
      .limit(DEFAULT_LAYERS_LIMIT),
  );
  return rows.map(({ map_layers: _embeddedParent, ...override }) => override);
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads; design §8.1 — every read a queryOptions)
// ---------------------------------------------------------------------------

export function listQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "list"],
    queryFn: async () => await list(options),
  });
}

export function getQueryOptions(args: { mapId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "get", args],
    queryFn: async () => await get(args, options),
  });
}

export function listLayersQueryOptions(args: { mapId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "listLayers", args],
    queryFn: async () => await listLayers(args, options),
  });
}

export function listOverridesQueryOptions(args: { mapId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "listOverrides", args],
    queryFn: async () => await listOverrides(args, options),
  });
}

// ---------------------------------------------------------------------------
// Writes — map rows
// ---------------------------------------------------------------------------

/** `api.cms.maps.create` parity. Returns the new map's id. */
export async function create(
  args: { name: string; description?: string },
  options?: StoreOptions,
): Promise<string> {
  const row = await queryRow<{ id: string }>(
    clientOf(options)
      .from("maps")
      .insert({
        name: args.name,
        ...(args.description === undefined ? {} : { description: args.description }),
      })
      .select("id")
      .single(),
  );
  if (row === null) {
    throw new Error("Map insert returned no row.");
  }
  return row.id;
}

/** `api.cms.maps.update` parity. */
export async function update(
  args: { mapId: string; name: string; description?: string },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("maps")
      .update({
        name: args.name,
        // A cleared description must overwrite the old one (the Convex
        // mutation set it to null when the field emptied).
        description: args.description ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.mapId)
      .select("id"),
  );
}

/** Deletes the map; its layers and their overrides go with it by cascade (§3.4). */
export async function remove(args: { mapId: string }, options?: StoreOptions): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("maps").delete().eq("id", args.mapId).select("id"),
  );
}

// ---------------------------------------------------------------------------
// Writes — layers
// ---------------------------------------------------------------------------

/** `api.cms.maps.addLayer` parity: appends the target at the end of the map's draw order. */
export async function addLayer(
  args: {
    mapId: string;
    targetId: string;
    targetType: MapLayerRow["targetType"];
    /** Overrides the computed draw position (the create-and-add flow's first layer). */
    order?: number;
  },
  options?: StoreOptions,
): Promise<MapLayerRow> {
  const client = clientOf(options);
  let order = args.order;
  if (order === undefined) {
    const existing = await listLayers({ mapId: args.mapId }, options);
    const last = existing[existing.length - 1];
    order = last === undefined ? 0 : last.order + 1;
  }
  const row = await queryRow<MapLayerRow>(
    client
      .from("map_layers")
      .insert({
        map_id: args.mapId,
        order,
        target_id: args.targetId,
        target_type: args.targetType,
      })
      .select(LAYER_SELECT)
      .single(),
  );
  if (row === null) {
    throw new Error("Layer insert returned no row.");
  }
  return row;
}

/** Removes one layer; its overrides go with it by cascade (§3.4). */
export async function removeLayer(
  args: { layerId: string },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("map_layers").delete().eq("id", args.layerId).select("id"),
  );
}

/** `api.cms.maps.setLayerVisibility` parity. */
export async function setLayerVisibility(
  args: { layerId: string; visible: boolean },
  options?: StoreOptions,
): Promise<void> {
  await queryRows<unknown>(
    clientOf(options)
      .from("map_layers")
      .update({ visible: args.visible })
      .eq("id", args.layerId)
      .select("id"),
  );
}

/**
 * `api.cms.maps.moveLayer` parity: swaps the layer's draw position with its
 * neighbor's (two updates — see the module comment's transaction note). The
 * layer must exist and have a neighbor in the given direction; an unknown
 * neighbor (single-layer map, gap at the edge) is a no-op, matching the
 * panel's disabled buttons.
 */
export async function moveLayer(
  args: { layerId: string; direction: "up" | "down" },
  options?: StoreOptions,
): Promise<void> {
  const client = clientOf(options);
  const layer = await queryRow<MapLayerRow>(
    client.from("map_layers").select(LAYER_SELECT).eq("id", args.layerId).limit(1),
  );
  if (layer === null) {
    return;
  }
  const siblings = await listLayers({ mapId: layer.mapId }, options),
    index = siblings.findIndex((sibling) => sibling.id === layer.id),
    neighborIndex = args.direction === "up" ? index - 1 : index + 1,
    neighbor = neighborsAt(siblings, neighborIndex);
  if (neighbor === undefined) {
    return;
  }
  // Update the neighbor FIRST: while mid-swap, the moving layer still holds
  // its old position, so ordering reads stay gap-free.
  await queryRows<unknown>(
    client.from("map_layers").update({ order: layer.order }).eq("id", neighbor.id).select("id"),
  );
  await queryRows<unknown>(
    client.from("map_layers").update({ order: neighbor.order }).eq("id", layer.id).select("id"),
  );
}

/** The sibling at `index`, or nothing (edge/no-neighbor). */
function neighborsAt(siblings: MapLayerRow[], index: number): MapLayerRow | undefined {
  if (index < 0) {
    return undefined;
  }
  return siblings[index];
}

// ---------------------------------------------------------------------------
// Writes — child overrides (issue #53 semantics; see the module comment)
// ---------------------------------------------------------------------------

/**
 * `api.cms.maps.setMapLayerOverride` parity: HIDING a child upserts a
 * `{visible: false}` row on the unique `(layer_id, child_key)`; SHOWING
 * clears any override row.
 */
export async function setMapLayerOverride(
  args: { layerId: string; childKey: string; visible: boolean },
  options?: StoreOptions,
): Promise<void> {
  const client = clientOf(options);
  if (args.visible) {
    await queryRows<unknown>(
      client
        .from("map_layer_overrides")
        .delete()
        .eq("layer_id", args.layerId)
        .eq("child_key", args.childKey)
        .select("id"),
    );
    return;
  }
  await queryRows<unknown>(
    client
      .from("map_layer_overrides")
      .upsert(
        { child_key: args.childKey, layer_id: args.layerId, visible: false },
        { onConflict: "layer_id,child_key" },
      )
      .select("id"),
  );
}
