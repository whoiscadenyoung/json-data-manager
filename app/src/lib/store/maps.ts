import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * The maps store (issue #257 — the project-centric train's phase 3; ADR
 * 0019) — project-owned maps and their LAYER PLACEMENTS over
 * `public.maps` + `public.map_layers`.
 *
 * The recorded shapes (ADR 0019):
 *   - Maps are project ROWS, never project_artifacts memberships: reads
 *     are member-wide, content writes are editor+ (the 0018 role split —
 *     the 0005 authenticated-wide policies are gone). D2: the /maps
 *     explorer lists every map the viewer can see; creation lives in
 *     projects.
 *   - A placement names a layer MEMBERSHIP (a project_artifacts row of
 *     kind 'layer'): owned layers answer via their layers row, linked ones
 *     via their pinned layer_versions row (the membership's artifact_id).
 *     The old direct dataset/collection/group target modes retired — "add
 *     dataset to map" now flows through the layers store's auto-layer
 *     (membership + owned layer, then this store places it).
 *   - Draw order (`order`) is written contiguously, gaps allowed after
 *     removals; only relative order renders; every read tie-breaks on id
 *     (no unique constraint on (map_id, order) — the 0005 rule).
 *   - `movePlacement("up"|"down")` swaps positions with the neighbor in
 *     two updates (single-statement PostgREST; a crash mid-swap leaves a
 *     harmless duplicate order, tie-broken by id).
 *   - `viewport` is whatever the editor last captured (bounds + zoom);
 *     `basemap` the saved style — both free-form editor state.
 *
 * NOTE: narrow local interfaces typed from the migration 0020 DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/** One project-owned map, as every reader of `maps` gets it (the project embed names it for the explorer's chips). */
export interface MapRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** Display order in the project's Maps view (append-assigned; gaps fine). */
  order: number;
  /** The saved camera (bounds + zoom) — whatever the editor last captured. */
  viewport: unknown;
  basemap: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The owning project's title (FK embed — the explorer's chip). */
  project: { id: string; title: string };
}

/** One layer placement on a map, in draw order. */
export interface MapPlacementRow {
  id: string;
  mapId: string;
  /** Draw/list position; gaps allowed after removals — relative order renders. */
  order: number;
  /** The layer MEMBERSHIP (project_artifacts kind 'layer') this placement shows. */
  layerMemberId: string;
  /** The map-local visibility toggle (the layer's own `visible` is the layer-wide default). */
  visible: boolean;
}

const MAP_SELECT =
    "id,projectId:project_id,name,description,order,viewport,basemap,createdBy:created_by,createdAt:created_at,updatedAt:updated_at,project:projects(id,title)",
  PLACEMENT_SELECT = "id,mapId:map_id,order,layerMemberId:layer_member_id,visible";

/** The maps list width when a caller doesn't pin one (the Convex `list` call sites all passed 500). */
export const DEFAULT_MAPS_LIMIT = 500;

/** The placement-list width (the 0005 layers cap carried over). */
export const DEFAULT_PLACEMENTS_LIMIT = 500;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every map the viewer can see, newest first — the /maps EXPLORER's list
 * (D2: the explorer never creates; it browses). The project embed carries
 * the chips.
 */
export async function list(options?: StoreOptions): Promise<MapRow[]> {
  return await queryRows<MapRow>(
    clientOf(options)
      .from("maps")
      .select(MAP_SELECT)
      .order("created_at", { ascending: false })
      .limit(DEFAULT_MAPS_LIMIT),
  );
}

/** One project's maps in display order (the project Maps view's section). */
export async function listForProject(
  args: { projectId: string },
  options?: StoreOptions,
): Promise<MapRow[]> {
  return await queryRows<MapRow>(
    clientOf(options)
      .from("maps")
      .select(MAP_SELECT)
      .eq("project_id", args.projectId)
      .order("order", { ascending: true })
      .order("id", { ascending: true })
      .limit(DEFAULT_MAPS_LIMIT),
  );
}

/** One map by id, or null when RLS hides it (a non-member reads not-found). */
export async function get(args: { mapId: string }, options?: StoreOptions): Promise<MapRow | null> {
  return await queryRow<MapRow>(
    clientOf(options).from("maps").select(MAP_SELECT).eq("id", args.mapId).limit(1),
  );
}

/** The map's placements in draw order (`order` asc, `id` tie-break). */
export async function listPlacements(
  args: { mapId: string },
  options?: StoreOptions,
): Promise<MapPlacementRow[]> {
  return await queryRows<MapPlacementRow>(
    clientOf(options)
      .from("map_layers")
      .select(PLACEMENT_SELECT)
      .eq("map_id", args.mapId)
      .order("order", { ascending: true })
      .order("id", { ascending: true })
      .limit(DEFAULT_PLACEMENTS_LIMIT),
  );
}

/**
 * Every placement across the visible maps in one read — the explorer's
 * per-map placement counts (the listAllLayers shape, retargeted). Draw
 * order is meaningless across maps; this orders only by id.
 */
export async function listAllPlacements(options?: StoreOptions): Promise<MapPlacementRow[]> {
  return await queryRows<MapPlacementRow>(
    clientOf(options)
      .from("map_layers")
      .select(PLACEMENT_SELECT)
      .order("id", { ascending: true })
      .limit(DEFAULT_PLACEMENTS_LIMIT),
  );
}

// ---------------------------------------------------------------------------
// TanStack Query options
// ---------------------------------------------------------------------------

export function listQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "list"],
    queryFn: async () => await list(options),
  });
}

export function listForProjectQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "listForProject", args],
    queryFn: async () => await listForProject(args, options),
  });
}

export function getQueryOptions(args: { mapId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "get", args],
    queryFn: async () => await get(args, options),
  });
}

export function listPlacementsQueryOptions(args: { mapId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "listPlacements", args],
    queryFn: async () => await listPlacements(args, options),
  });
}

export function listAllPlacementsQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:maps", "listAllPlacements"],
    queryFn: async () => await listAllPlacements(options),
  });
}

// ---------------------------------------------------------------------------
// Writes — map rows (editor+ at RLS; silent-denial returns where the count
// matters, void where a zero-row answer is already "not found" upstream)
// ---------------------------------------------------------------------------

/**
 * Creates a map in a project. Returns the new row's id (null = denied —
 * not an editor of the project).
 */
export async function create(
  args: { projectId: string; name: string; description?: string },
  options?: StoreOptions,
): Promise<string | null> {
  const client = clientOf(options);
  const existing = await listForProject({ projectId: args.projectId }, options);
  const last = existing[existing.length - 1];
  const row = await queryRow<{ id: string }>(
    client
      .from("maps")
      .insert({
        ...(args.description === undefined ? {} : { description: args.description }),
        name: args.name,
        order: last === undefined ? 0 : last.order + 1,
        project_id: args.projectId,
      })
      .select("id")
      .single(),
  );
  return row === null ? null : row.id;
}

/** Updates the map's name/description (the form panel's fields). Returns the affected count. */
export async function update(
  args: { mapId: string; name: string; description?: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("maps")
      .update({
        // A cleared description must overwrite the old one (the Convex
        // mutation set it to null when the field emptied).
        description: args.description ?? null,
        name: args.name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.mapId)
      .select("id"),
  );
  return rows.length;
}

/** Saves the camera the editor last captured (the viewport CAS is deliberately absent — last-write-wins editor state). */
export async function saveViewport(
  args: { mapId: string; viewport: unknown },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("maps")
      .update({ updated_at: new Date().toISOString(), viewport: args.viewport })
      .eq("id", args.mapId)
      .select("id"),
  );
  return rows.length;
}

/** Deletes the map; its placements go with it by cascade. */
export async function remove(args: { mapId: string }, options?: StoreOptions): Promise<void> {
  await queryRows<unknown>(
    clientOf(options).from("maps").delete().eq("id", args.mapId).select("id"),
  );
}

// ---------------------------------------------------------------------------
// Writes — placements
// ---------------------------------------------------------------------------

/**
 * Appends one placement at the end of the map's draw order. Returns the
 * row (null = denied — not an editor, the map is gone, or the membership
 * is invisible).
 */
export async function addPlacement(
  args: { layerMemberId: string; mapId: string; order?: number },
  options?: StoreOptions,
): Promise<MapPlacementRow | null> {
  const client = clientOf(options);
  let order = args.order;
  if (order === undefined) {
    const existing = await listPlacements({ mapId: args.mapId }, options);
    const last = existing[existing.length - 1];
    order = last === undefined ? 0 : last.order + 1;
  }
  return await queryRow<MapPlacementRow>(
    client
      .from("map_layers")
      .insert({
        layer_member_id: args.layerMemberId,
        map_id: args.mapId,
        order,
      })
      .select(PLACEMENT_SELECT)
      .single(),
  );
}

/** Removes one placement (the layer itself stays — placements are the map's view of it). */
export async function removePlacement(
  args: { placementId: string },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("map_layers").delete().eq("id", args.placementId).select("id"),
  );
  return rows.length;
}

/** The map-local visibility toggle (the layer-wide default lives on the layer row). */
export async function setPlacementVisibility(
  args: { placementId: string; visible: boolean },
  options?: StoreOptions,
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("map_layers")
      .update({ visible: args.visible })
      .eq("id", args.placementId)
      .select("id"),
  );
  return rows.length;
}

/**
 * Swaps the placement's draw position with its neighbor's (two updates —
 * see the module comment). An unknown neighbor (single-placement map, gap
 * at the edge) is a no-op, matching the panel's disabled buttons.
 */
export async function movePlacement(
  args: { direction: "up" | "down"; placementId: string },
  options?: StoreOptions,
): Promise<void> {
  const client = clientOf(options);
  const placement = await queryRow<MapPlacementRow>(
    client.from("map_layers").select(PLACEMENT_SELECT).eq("id", args.placementId).limit(1),
  );
  if (placement === null) {
    return;
  }
  const siblings = await listPlacements({ mapId: placement.mapId }, options),
    index = siblings.findIndex((sibling) => sibling.id === placement.id),
    neighborIndex = args.direction === "up" ? index - 1 : index + 1,
    neighbor = siblings[neighborIndex];
  if (neighbor === undefined) {
    return;
  }
  // Update the neighbor FIRST: while mid-swap, the moving placement still
  // holds its old position, so ordering reads stay gap-free.
  await queryRows<unknown>(
    client.from("map_layers").update({ order: placement.order }).eq("id", neighbor.id).select("id"),
  );
  await queryRows<unknown>(
    client.from("map_layers").update({ order: neighbor.order }).eq("id", placement.id).select("id"),
  );
}
