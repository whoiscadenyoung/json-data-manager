import type { Geometry } from "@caden/json-cms/react";
import type { FunctionReturnType } from "convex/server";

import type { DatasetGeometryRow } from "#/lib/dataset-rows";
import { api } from "#convex/_generated/api";

/**
 * The project map editor's render model (phase 4 of the project-workspace
 * design, ADR 0012). The standalone maps' client-only `assignDatasetColors`
 * is gone: every layer carries a STORED style (`layers.style` — the palette
 * color the style panel edits), and the map draws one render layer per
 * styled placement, so the SAME dataset can draw twice in two colors when two
 * layers style it. Everything here keys on the RENDER layer, not the dataset.
 *
 * Module-level helpers only: the React Compiler memoizes plain derivations,
 * and the repo's lint bans chained manual memo over live query results.
 */

/** One placement of a layer on a map, as `api.projectMaps.layers` returns it. */
export type MapPlacement = FunctionReturnType<typeof api.projectMaps.layers>[number];

/** One owned layer of the project, as `api.layers.list` returns it. */
export type ProjectLayerRow = FunctionReturnType<typeof api.layers.list>[number];

/** One layer with its resolved group children, as `api.layers.get` returns it. */
export type LayerDetail = NonNullable<FunctionReturnType<typeof api.layers.get>>;

/** The stored style's editable fields, with every field present. */
export type LayerStyle = {
  color: string;
  fillColor: string;
  fillOpacity: number;
  opacity: number;
  radius: number;
  weight: number;
};

/** The raw stored-style shape (what the server stores and the reads serve — every field optional). */
export type StoredStyle = {
  color?: string;
  fillColor?: string;
  fillOpacity?: number;
  opacity?: number;
  radius?: number;
  weight?: number;
};

/**
 * The layer palette (layers.ts's LAYER_COLORS, mirrored client-side — the
 * convex module is server-only and must never ride an app import).
 */
export const LAYER_PALETTE = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
] as const;

/** The style a layer with no stored value draws in — the palette's first color, visible on every basemap. */
export const DEFAULT_LAYER_STYLE: LayerStyle = {
  color: LAYER_PALETTE[0],
  fillColor: LAYER_PALETTE[0],
  fillOpacity: 0.2,
  opacity: 1,
  radius: 5,
  weight: 2,
};

/** Picks `value` when it is a finite number, else the fallback. */
function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Picks `value` when it is a non-empty string, else the fallback. */
function stringOr(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** A stored style blob merged over the defaults, field by field: unknown fields drop, present ones win. */
export function styleOrDefault(style: StoredStyle | undefined): LayerStyle {
  const color = stringOr(style === undefined ? undefined : style.color, DEFAULT_LAYER_STYLE.color);
  return {
    color,
    fillColor: stringOr(style === undefined ? undefined : style.fillColor, color),
    fillOpacity: finiteOr(
      style === undefined ? undefined : style.fillOpacity,
      DEFAULT_LAYER_STYLE.fillOpacity,
    ),
    opacity: finiteOr(style === undefined ? undefined : style.opacity, DEFAULT_LAYER_STYLE.opacity),
    radius: finiteOr(style === undefined ? undefined : style.radius, DEFAULT_LAYER_STYLE.radius),
    weight: finiteOr(style === undefined ? undefined : style.weight, DEFAULT_LAYER_STYLE.weight),
  };
}

/**
 * The MapLibre paint sets one render layer draws with — the SINGLE mapping
 * from a (possibly group-scaled) style to paint, so nothing the style panel
 * edits can silently stop rendering: fill carries fill-color/fill-opacity,
 * strokes carry line-color/line-width AND line-opacity, and points carry
 * circle-color/circle-opacity/circle-radius (the shared stroke/point
 * opacity, the same sharing the panel's labels state). Cluster bubbles are
 * aggregation UI, not data ink — they keep their own look and do not dim.
 */
export function paintsForStyle(style: LayerStyle): {
  circlePaint: { "circle-color": string; "circle-opacity": number; "circle-radius": number };
  fillPaint: { "fill-color": string; "fill-opacity": number };
  linePaint: { "line-color": string; "line-opacity": number; "line-width": number };
} {
  return {
    circlePaint: {
      "circle-color": style.color,
      "circle-opacity": style.opacity,
      "circle-radius": style.radius,
    },
    fillPaint: {
      "fill-color": style.fillColor,
      "fill-opacity": style.fillOpacity,
    },
    linePaint: {
      "line-color": style.color,
      "line-opacity": style.opacity,
      "line-width": style.weight,
    },
  };
}

/** Strips to the stored shape, so a style patch writes only what the panel edited. */
export function storedStyleOf(style: LayerStyle): StoredStyle {
  return {
    color: style.color,
    fillColor: style.fillColor,
    fillOpacity: style.fillOpacity,
    opacity: style.opacity,
    radius: style.radius,
    weight: style.weight,
  };
}

/**
 * One render layer: a styled, drawable unit of the map. Flattened from the
 * map's placements — an owned data layer is itself, a linked layer draws its
 * frozen definition, and a placed group contributes one render layer per
 * child (each child's own style and visibility, gated by the group's
 * placement eye). `datasetId` is the component schema id whose geometry rows
 * draw — `undefined` only when the layer has nothing to draw from (a linked
 * layer whose version never froze a dataset pin, or a nested group drawn via
 * its own direct placement).
 */
export type RenderLayer = {
  /** Unique key: the placement id, or `placementId:childLayerId` for a group child. */
  renderId: string;
  /** The placement this render layer came from (the panel's selection anchor). */
  placementId: string;
  datasetId: string | undefined;
  name: string;
  style: LayerStyle;
  visible: boolean;
  kind: "owned" | "linked" | "group-child";
  /** The group placement this child renders under (kind "group-child" only). */
  parentPlacementId?: string;
  needsAttention?: string;
  lifecycle?: "draft" | "published";
};

/**
 * One resolved child of a group layer, as `layers.get`'s `children` carry it
 * (the read validates the envelope shapelessly, so the lib narrows the two
 * child shapes explicitly).
 */
export type GroupChild =
  | {
      childKind: "owned";
      childLayerId: string;
      datasetMemberId?: string;
      kind: "data" | "group";
      lifecycle: "draft" | "published";
      name: string;
      needsAttention?: string;
      opacity?: number;
      style?: StoredStyle;
      visible: boolean;
    }
  | {
      childKind: "linked";
      childLayerId: string;
      datasetPinnedSchemaId?: string;
      kind: "data" | "group";
      name: string;
      opacity?: number;
      style?: StoredStyle;
      versionLabel: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows one owned child row (the live-layer arm of the read). */
function narrowOwnedChild(child: Record<string, unknown>, childLayerId: string): GroupChild {
  return {
    childKind: "owned",
    childLayerId,
    datasetMemberId: typeof child.datasetMemberId === "string" ? child.datasetMemberId : undefined,
    kind: child.kind === "group" ? "group" : "data",
    lifecycle: child.lifecycle === "published" ? "published" : "draft",
    name: typeof child.name === "string" ? child.name : "Layer",
    needsAttention: typeof child.needsAttention === "string" ? child.needsAttention : undefined,
    opacity: typeof child.opacity === "number" ? child.opacity : undefined,
    style: narrowStoredStyle(child.style),
    visible: child.visible !== false,
  };
}

/** Narrows one linked child row (the pinned-version arm of the read). */
function narrowLinkedChild(child: Record<string, unknown>, childLayerId: string): GroupChild {
  return {
    childKind: "linked",
    childLayerId,
    datasetPinnedSchemaId:
      typeof child.datasetPinnedSchemaId === "string" ? child.datasetPinnedSchemaId : undefined,
    kind: child.kind === "group" ? "group" : "data",
    name: typeof child.name === "string" ? child.name : "Linked layer",
    opacity: typeof child.opacity === "number" ? child.opacity : undefined,
    style: narrowStoredStyle(child.style),
    versionLabel: typeof child.versionLabel === "string" ? child.versionLabel : "",
  };
}

/** Narrows one `layers.get` child row to the GroupChild union; nulls (deleted rows) answer undefined. */
function narrowChild(row: unknown): GroupChild | undefined {
  if (!isRecord(row) || row.child === null || !isRecord(row.child)) {
    return undefined;
  }
  const childLayerId = typeof row.childLayerId === "string" ? row.childLayerId : undefined;
  if (childLayerId === undefined) {
    return undefined;
  }
  return row.childKind === "linked"
    ? narrowLinkedChild(row.child, childLayerId)
    : narrowOwnedChild(row.child, childLayerId);
}

/** Narrows a stored style blob (shapeless from the read) field by field — no casts. */
export function narrowStoredStyle(value: unknown): StoredStyle | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    color: typeof value.color === "string" ? value.color : undefined,
    fillColor: typeof value.fillColor === "string" ? value.fillColor : undefined,
    fillOpacity: typeof value.fillOpacity === "number" ? value.fillOpacity : undefined,
    opacity: typeof value.opacity === "number" ? value.opacity : undefined,
    radius: typeof value.radius === "number" ? value.radius : undefined,
    weight: typeof value.weight === "number" ? value.weight : undefined,
  };
}

/**
 * The children of one group detail, in draw order, narrowed — deleted rows
 * drop (the defensive-answer convention; the group draws its survivors).
 */
export function orderedChildrenOf(detail: LayerDetail): GroupChild[] {
  const pairs: Array<{ child: GroupChild; order: number }> = [];
  for (const row of detail.children) {
    if (!isRecord(row) || typeof row.order !== "number") {
      continue;
    }
    const child = narrowChild(row);
    if (child !== undefined) {
      pairs.push({ child, order: row.order });
    }
  }
  return (
    pairs
      // oxlint-disable-next-line unicorn/no-array-sort -- a freshly built throwaway inside this helper; .toSorted() isn't in the lib the app typechecks against (the projectMaps.test precedent).
      .sort((a, b) => a.order - b.order)
      .map((pair) => pair.child)
  );
}

/**
 * The map's render layers, flattened from its placements in draw order:
 *
 * - an OWNED placement renders its live layer (the placement's embedded
 *   projection) — a data layer as itself, a group through its resolved
 *   children (`groupDetailById`, fetched per placed group), the group's own
 *   placement eye gating every child;
 * - a LINKED placement renders its pinned version's frozen definition —
 *   frozen style, frozen dataset pin;
 * - a MISSING placement contributes nothing to the canvas (the panel keeps
 *   the row and offers removal — the defensive-answer convention).
 *
 * `datasetIdByMembershipId` is the workspace read's join (membership id →
 * the component dataset id it references): owned layers style DATASETS
 * through memberships, but geometry rows key on the dataset id.
 */
export function effectiveRenderLayers(
  placements: readonly MapPlacement[],
  groupDetailById: ReadonlyMap<string, LayerDetail>,
  datasetIdByMembershipId: ReadonlyMap<string, string>,
): RenderLayer[] {
  const renderLayers: RenderLayer[] = [];
  for (const placement of placements) {
    if (placement.kind === "owned") {
      const layer = placement.layer;
      if (layer.kind === "group") {
        const detail = groupDetailById.get(layer.layerId);
        if (detail !== undefined) {
          for (const child of orderedChildrenOf(detail)) {
            renderLayers.push(groupChildRenderLayer(placement, child, datasetIdByMembershipId));
          }
        }
      } else {
        renderLayers.push({
          datasetId:
            layer.datasetMemberId === undefined
              ? undefined
              : datasetIdByMembershipId.get(layer.datasetMemberId),
          kind: "owned",
          lifecycle: layer.lifecycle,
          name: layer.name,
          needsAttention: layer.needsAttention,
          placementId: placement._id,
          renderId: placement._id,
          style: styleOrDefault(layer.style),
          // Both eyes: the map-local placement eye AND the layer-wide one
          // (the Layers-tab eye hides the layer on every map it sits on).
          visible: placement.visible && layer.visible,
        });
      }
      continue;
    }
    if (placement.kind === "linked") {
      const layer = placement.layer;
      renderLayers.push({
        datasetId: layer.pinnedSchemaId,
        kind: "linked",
        name: layer.name,
        placementId: placement._id,
        renderId: placement._id,
        style: styleOrDefault(layer.style),
        // A pin has no layer-wide eye of its own (one read-only unit; local
        // visibility toggles only, per the model) — the placement eye gates.
        visible: placement.visible,
      });
    }
    // kind "missing": nothing to draw — the panel renders the row.
  }
  return renderLayers;
}

/** Clamps a number into [0, 1] — opacity scalars never leave that range. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The dataset a group child draws from, resolved per child kind (undefined when it draws nothing). */
function childDatasetIdOf(
  child: GroupChild,
  datasetIdByMembershipId: ReadonlyMap<string, string>,
): string | undefined {
  if (child.childKind === "owned") {
    return child.datasetMemberId === undefined
      ? undefined
      : datasetIdByMembershipId.get(child.datasetMemberId);
  }
  return child.datasetPinnedSchemaId;
}

/** Whether this child draws geometry at all — a nested group child draws via its own direct placement. */
function childDraws(child: GroupChild): boolean {
  if (child.childKind === "owned") {
    return child.kind === "data";
  }
  return child.datasetPinnedSchemaId !== undefined;
}

/** One group child's render layer: gated by both group eyes, tinted by the group's opacity. */
function groupChildRenderLayer(
  placement: Extract<MapPlacement, { kind: "owned" }>,
  child: GroupChild,
  datasetIdByMembershipId: ReadonlyMap<string, string>,
): RenderLayer {
  const style = styleOrDefault(child.style),
    // The group's transparency is the one style a group layer owns: it
    // scales every child's fill/stroke opacities (absent reads as 1).
    groupOpacity = clamp01(placement.layer.opacity ?? 1);
  return {
    datasetId: childDraws(child) ? childDatasetIdOf(child, datasetIdByMembershipId) : undefined,
    kind: "group-child",
    lifecycle: child.childKind === "owned" ? child.lifecycle : undefined,
    name: child.name,
    needsAttention: child.childKind === "owned" ? child.needsAttention : undefined,
    parentPlacementId: placement._id,
    placementId: placement._id,
    renderId: `${placement._id}:${child.childLayerId}`,
    style: {
      ...style,
      fillOpacity: clamp01(style.fillOpacity * groupOpacity),
      opacity: clamp01(style.opacity * groupOpacity),
    },
    // Three gates for an owned child: the placement's map-local eye, the
    // group layer's own eye (the Layers-tab one), and the child layer's. A
    // linked child has no local eye (read-only pin), so it rides the two
    // group gates.
    visible:
      placement.visible &&
      (placement.layer.visible ?? true) &&
      (child.childKind === "owned" ? child.visible : true),
  };
}

/**
 * Re-keys geometry rows per render layer: every row draws once per render
 * layer showing its dataset (two layers styling one dataset draw it twice,
 * each in its own style), each copy under the RENDER id with
 * `sourceSchemaId` preserving where the entry actually lives — the click
 * payload's dataset link. Built in a loop, not a map callback (the
 * map-spread rule).
 */
export function keyedGeometryRows(
  geometries: readonly DatasetGeometryRow[],
  renderIdsByDatasetId: ReadonlyMap<string, string[]>,
): Array<DatasetGeometryRow & { sourceSchemaId?: string }> {
  const keyed: Array<DatasetGeometryRow & { sourceSchemaId?: string }> = [];
  for (const row of geometries) {
    const renderIds = renderIdsByDatasetId.get(row.schemaId);
    if (renderIds === undefined) {
      continue;
    }
    for (const renderId of renderIds) {
      const copy: DatasetGeometryRow & { sourceSchemaId?: string } = {
        ...row,
        schemaId: renderId,
      };
      copy.sourceSchemaId = row.schemaId;
      keyed.push(copy);
    }
  }
  return keyed;
}

/** Render id → the render ids drawing it, one entry per visible dataset per layer (the geometry re-key's input). */
export function renderIdsByDatasetIdOf(
  renderLayers: readonly RenderLayer[],
): globalThis.Map<string, string[]> {
  const byDataset = new globalThis.Map<string, string[]>();
  for (const layer of renderLayers) {
    if (layer.datasetId === undefined || !layer.visible) {
      continue;
    }
    const existing = byDataset.get(layer.datasetId);
    if (existing === undefined) {
      byDataset.set(layer.datasetId, [layer.renderId]);
    } else {
      existing.push(layer.renderId);
    }
  }
  return byDataset;
}

/**
 * A map-renderable feature row given its already-resolved `Geometry`. The
 * feature points at the entry's real home dataset (`sourceSchemaId`) so the
 * popup and its "View details" link keep working.
 */
export function toFeatureRow(
  geometry: DatasetGeometryRow & { sourceSchemaId?: string },
  resolved: Geometry,
) {
  return {
    id: geometry.entryId,
    geometry: resolved,
    properties: {
      entryId: geometry.entryId,
      schemaId: geometry.sourceSchemaId ?? geometry.schemaId,
    },
  };
}

/** The unique dataset ids a set of render layers would draw (geometry subscription keys), in first-appearance order. */
export function datasetIdsOf(renderLayers: readonly RenderLayer[]): string[] {
  const ids: string[] = [];
  const seen = new globalThis.Set<string>();
  for (const layer of renderLayers) {
    if (layer.datasetId !== undefined && !seen.has(layer.datasetId)) {
      seen.add(layer.datasetId);
      ids.push(layer.datasetId);
    }
  }
  return ids;
}

/** Render id → dataset id, for click payloads and the tile-path wiring. */
export function datasetIdByRenderId(
  renderLayers: readonly RenderLayer[],
): globalThis.Map<string, string> {
  const byId = new globalThis.Map<string, string>();
  for (const layer of renderLayers) {
    if (layer.datasetId !== undefined) {
      byId.set(layer.renderId, layer.datasetId);
    }
  }
  return byId;
}

/** The arrived-set update for one tile source's `idle` report (bails out of the state update when already present). */
export function withArrivedTileSchema(prev: ReadonlySet<string>, schemaId: string): Set<string> {
  if (prev.has(schemaId)) {
    return new Set(prev);
  }
  return new Set(prev).add(schemaId);
}

/** A nullable list as an empty list — the row path serves `undefined` before its first rows land, and the map renders tile sources (or nothing) then. */
export function withEmptyRows<T>(rows: T[] | undefined): T[] {
  return rows === undefined ? [] : rows;
}

/**
 * The workspace is fully loaded: every row-path pass finished, every tile
 * source reached `idle`, and no source decision is still pending.
 */
export function isLayersWorkspaceComplete(
  geometries: unknown,
  sourcesPending: boolean,
  tileSchemaIds: readonly string[],
  arrivedSchemaIds: ReadonlySet<string>,
): boolean {
  if (geometries === undefined || sourcesPending) {
    return false;
  }
  for (const schemaId of tileSchemaIds) {
    if (!arrivedSchemaIds.has(schemaId)) {
      return false;
    }
  }
  return true;
}

/**
 * The map mounts on the first served rows OR any tile source — before that
 * only the loading chip shows.
 */
export function layersMapShouldMount(servedGeometries: unknown, tileSourceCount: number): boolean {
  return servedGeometries !== undefined || tileSourceCount > 0;
}
