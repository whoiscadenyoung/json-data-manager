import type { LayerStyle, StyleLayer } from "./validators";

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
  /** True when a layer had to be dropped or simplified (labels, data filters, per-class icons/sizes), so the editor can say why. */
  dropped: boolean;
}

function readsData(node: unknown): boolean {
  const fields = new Set<string>();
  collectFields(node, fields);
  return fields.size > 0;
}

/**
 * A data-free stand-in for a data-driven layout value: a `match`/`case`'s
 * fallback or a `step`'s first output (the "Other" icon, the base size), or
 * `undefined` when there is none (a label's text).
 */
function staticFallback(node: unknown): unknown {
  if (!readsData(node)) {
    return node;
  }
  if (!Array.isArray(node)) {
    return undefined;
  }
  const [op] = node;
  if (op === "match" || op === "case") {
    return staticFallback(node.at(-1));
  }
  if (op === "step") {
    return staticFallback(node[2]);
  }
  return undefined;
}

/** The layout with every data read replaced by its static fallback, or `undefined` if one has none. */
function staticLayout(
  layout: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (layout === undefined) {
    return undefined;
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layout)) {
    const fallback = staticFallback(value);
    if (fallback === undefined) {
      return undefined;
    }
    next[key] = fallback;
  }
  return next;
}

/**
 * The tile path's version of a style's layers. Tile features carry only
 * `entryId`, so field values ride MapLibre feature-state instead of
 * properties — which MapLibre allows in `paint` only. Paint reads are
 * rewritten onto feature-state. A data-driven `layout` value falls back to
 * its static default (a per-category icon to the marker's own icon, a class
 * size to the base size); a layer with no such default (labels) or a data
 * filter can't render from tiles and is dropped (geometry-type filters read
 * no data and stay).
 */
export function tileLayers(source: readonly StyleLayer[]): TileLayersResult {
  let dropped = false;
  const layers: StyleLayer[] = [];
  for (const layer of source) {
    const layout = staticLayout(layer.layout);
    if (readsData(layer.filter) || (layer.layout !== undefined && layout === undefined)) {
      dropped = true;
      continue;
    }
    if (readsData(layer.layout)) {
      dropped = true;
    }
    layers.push({
      ...layer,
      ...(layout === undefined ? {} : { layout }),
      ...(layer.paint === undefined
        ? {}
        : {
            paint: Object.fromEntries(
              Object.entries(layer.paint).map(([key, value]) => [key, toFeatureState(value)]),
            ),
          }),
    });
  }
  return { dropped, layers };
}

/** Whether any layer of the style can't render as-is from tiles (see `tileLayers`). */
export function hasTileLimitations(style: LayerStyle): boolean {
  return tileLayers(style.layers).dropped;
}
