import type { LayerStyle, StyleLayer } from "#convex/layerStyles/validators";

/**
 * Which sprite images a style draws (`icon-image`), so the map can load them,
 * an export can bundle them, an import can name the unknown ones, and a
 * style whose uploaded icon was deleted can fall back to circles.
 */

/** The icon names an `icon-image` value can produce: literal outputs of `match`/`case`/`step`/`coalesce`/`image`. */
function collectIconNames(node: unknown, into: Set<string>) {
  if (typeof node === "string") {
    // `{field}` tokens are legacy data reads, not image names.
    if (node !== "" && !node.includes("{")) {
      into.add(node);
    }
    return;
  }
  if (!Array.isArray(node) || typeof node[0] !== "string") {
    return;
  }
  const [op] = node,
    last = node.length - 1;
  if (op === "image") {
    collectIconNames(node[1], into);
  } else if (op === "match") {
    for (let index = 3; index < last; index += 2) {
      collectIconNames(node[index], into);
    }
    collectIconNames(node[last], into);
  } else if (op === "case") {
    for (let index = 2; index < last; index += 2) {
      collectIconNames(node[index], into);
    }
    collectIconNames(node[last], into);
  } else if (op === "step") {
    collectIconNames(node[2], into);
    for (let index = 4; index <= last; index += 2) {
      collectIconNames(node[index], into);
    }
  } else if (op === "coalesce") {
    for (const child of node.slice(1)) {
      collectIconNames(child, into);
    }
  }
}

/** The icon names one layer draws (empty for non-symbol layers and text-only labels). */
export function iconNamesOfLayer(layer: StyleLayer): string[] {
  if (layer.type !== "symbol" || layer.layout === undefined) {
    return [];
  }
  const names = new Set<string>();
  collectIconNames(layer.layout["icon-image"], names);
  return [...names];
}

/** Every icon name a set of layers draws, sorted. */
export function iconNamesOfLayers(layers: readonly StyleLayer[]): string[] {
  return [...new Set(layers.flatMap(iconNamesOfLayer))].toSorted();
}

/** Every icon name a style draws, sorted. */
export function iconNamesOfStyle(style: LayerStyle): string[] {
  return iconNamesOfLayers(style.layers);
}

/** A circle in the icon layer's color — what a marker draws as once its icon is gone. */
function circleFallback(layer: StyleLayer): StyleLayer {
  const paint = layer.paint === undefined ? {} : layer.paint,
    color = paint["icon-color"] ?? "#3b82f6";
  return {
    ...(layer.filter === undefined ? {} : { filter: layer.filter }),
    ...(layer.minzoom === undefined ? {} : { minzoom: layer.minzoom }),
    ...(layer.maxzoom === undefined ? {} : { maxzoom: layer.maxzoom }),
    paint: {
      "circle-color": color,
      "circle-radius": 5,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
    type: "circle",
  };
}

export interface IconFallbackResult {
  layers: StyleLayer[];
  /** Icon names the style draws that aren't available (deleted uploads). */
  missing: string[];
}

/**
 * Swaps every icon layer that draws an unavailable image for a circle layer
 * in the same color, and reports the missing names — so a deleted upload
 * never leaves points invisible, and the editor can say why they changed.
 */
export function withIconFallback(
  layers: readonly StyleLayer[],
  isAvailable: (name: string) => boolean,
): IconFallbackResult {
  const missing = new Set<string>(),
    next = layers.map((layer) => {
      const gone = iconNamesOfLayer(layer).filter((name) => !isAvailable(name));
      if (gone.length === 0) {
        return layer;
      }
      for (const name of gone) {
        missing.add(name);
      }
      return circleFallback(layer);
    });
  return { layers: next, missing: [...missing].toSorted() };
}

/** Whether an icon name is an upload (`user-<id>`), and its upload id. */
export function uploadIdOf(name: string): string | undefined {
  return name.startsWith("user-") ? name.slice("user-".length) : undefined;
}
