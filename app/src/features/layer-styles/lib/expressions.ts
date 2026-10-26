import type { LayerStyle, StyleLayer } from "#convex/layerStyles/validators";

/**
 * Expression plumbing between a stored style and the two render paths:
 * which data fields a style reads (so only those datasets load entry values),
 * and the tile-path rewrite onto feature-state.
 */

/** The `["get", "<field>"]` form — a property read with a literal name and no object argument. */
function propertyRead(node: unknown): string | undefined {
  if (
    Array.isArray(node) &&
    node.length === 2 &&
    node[0] === "get" &&
    typeof node[1] === "string"
  ) {
    return node[1];
  }
  return undefined;
}

function collectFields(node: unknown, into: Set<string>) {
  if (!Array.isArray(node)) {
    if (typeof node === "object" && node !== null) {
      for (const value of Object.values(node)) {
        collectFields(value, into);
      }
    }
    return;
  }
  const field = propertyRead(node);
  if (field !== undefined) {
    into.add(field);
    return;
  }
  for (const child of node) {
    collectFields(child, into);
  }
}

/** Data fields read anywhere in a set of layers (paint, layout, filter). */
export function fieldsOfLayers(layers: readonly StyleLayer[]): string[] {
  const fields = new Set<string>();
  for (const layer of layers) {
    collectFields(layer.paint, fields);
    collectFields(layer.layout, fields);
    collectFields(layer.filter, fields);
  }
  return [...fields].toSorted();
}

/** Data fields a style reads. */
export function fieldsOfStyle(style: LayerStyle): string[] {
  return fieldsOfLayers(style.layers);
}

/** Replaces every `["get", field]` with `["feature-state", field]`. */
function toFeatureState(node: unknown): unknown {
  if (!Array.isArray(node)) {
    return node;
  }
  const field = propertyRead(node);
  if (field !== undefined) {
    return ["feature-state", field];
  }
  return node.map(toFeatureState);
}

export interface TileLayersResult {
  layers: StyleLayer[];
  /** True when a layer had to be dropped (labels or a data filter), so the editor can say why. */
  dropped: boolean;
}

/**
 * The tile path's version of a style. Tile features carry only `entryId`,
 * so field values ride MapLibre feature-state instead of properties —
 * which MapLibre allows in `paint` only. Paint reads are rewritten onto
 * feature-state; a layer whose `layout` or `filter` reads data (labels,
 * attribute filters) can't render from tiles and is dropped (geometry-type
 * filters read no data and stay).
 */
export function tileLayers(style: LayerStyle): TileLayersResult {
  let dropped = false;
  const layers: StyleLayer[] = [];
  for (const layer of style.layers) {
    const dataInLayout = fieldsOfLayers([{ layout: layer.layout, type: layer.type }]).length > 0,
      dataInFilter = fieldsOfLayers([{ filter: layer.filter, type: layer.type }]).length > 0;
    if (dataInLayout || dataInFilter) {
      dropped = true;
      continue;
    }
    layers.push(
      layer.paint === undefined
        ? layer
        : {
            ...layer,
            paint: Object.fromEntries(
              Object.entries(layer.paint).map(([key, value]) => [key, toFeatureState(value)]),
            ),
          },
    );
  }
  return { dropped, layers };
}

/** Whether any layer of the style can't render from tiles (see `tileLayers`). */
export function hasTileLimitations(style: LayerStyle): boolean {
  return tileLayers(style).dropped;
}
