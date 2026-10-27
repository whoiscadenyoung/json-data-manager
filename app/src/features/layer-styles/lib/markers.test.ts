import { readFileSync } from "node:fs";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  ICON_LIMITS,
  ICON_NAME_PATTERN,
  type Marker,
  type StyleEditor,
} from "#convex/layerStyles/validators";

import {
  colorExpression,
  compileStyle,
  defaultEditor,
  ICON_GLYPH_PX,
  sizeExpression,
} from "./compile";
import { importStyleJson, validateLayers } from "./exchange";
import { tileLayers } from "./expressions";
import { iconNamesOfLayers, iconNamesOfStyle, withIconFallback } from "./icons";
import { legendClasses, singleMarkerIcon } from "./legend";
import { SDF_EDGE, sdfFromAlpha, sdfImage, sdfParams } from "./sdf";
import { packSprite, spriteReadme } from "./sprite-export";
import {
  checkPngSize,
  checkUploadFile,
  fitWithin,
  iconLabelFromFileName,
  inspectSvg,
} from "./uploads";

const ICON: Marker = {
  allowOverlap: true,
  icon: "lucide-school",
  kind: "icon",
  rotation: 0,
  size: 24,
};

function editorWith(patch: Partial<StyleEditor>): StyleEditor {
  return { ...defaultEditor("#3b82f6"), ...patch };
}

const CATEGORIES: StyleEditor["renderer"] = {
  categories: [
    { color: "#111111", icon: "maki-hospital", value: "Hospital" },
    { color: "#222222", value: "Clinic" },
  ],
  field: "kind",
  kind: "categorical",
  otherColor: "#999999",
};

const GRADUATED: StyleEditor["renderer"] = {
  breaks: [10, 20],
  colors: ["#aaaaaa", "#bbbbbb", "#cccccc"],
  field: "pop",
  kind: "graduated",
  method: "equal",
  ramp: "blues",
};

function pointLayer(editor: StyleEditor) {
  const layer = compileStyle(editor).layers[3];
  if (layer === undefined) {
    throw new Error("no point layer");
  }
  return layer;
}

describe("compile: point markers", () => {
  it("keeps circles when there is no marker or a circle marker", () => {
    expect(pointLayer(editorWith({})).type).toBe("circle");
    const circle = pointLayer(editorWith({ marker: { ...ICON, kind: "circle" } }));
    expect(circle.type).toBe("circle");
    expect(circle.paint).toMatchObject({ "circle-radius": 5 });
  });

  it("draws a shape as a tinted symbol layer", () => {
    const layer = pointLayer(
      editorWith({ marker: { ...ICON, icon: "shape-triangle", kind: "shape", size: 12 } }),
    );
    expect(layer).toMatchObject({
      layout: {
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-image": "shape-triangle",
        "icon-size": 12 / ICON_GLYPH_PX,
      },
      paint: { "icon-color": "#3b82f6", "icon-halo-color": "#ffffff" },
      type: "symbol",
    });
    expect(layer.layout).not.toHaveProperty("icon-rotate");
  });

  it("rotates icons and anchors pins at their tip", () => {
    expect(pointLayer(editorWith({ marker: { ...ICON, rotation: 45 } })).layout).toMatchObject({
      "icon-rotate": 45,
    });
    expect(
      pointLayer(editorWith({ marker: { ...ICON, icon: "shape-pin", kind: "shape" } })).layout,
    ).toMatchObject({ "icon-anchor": "bottom" });
  });

  it("gives categories their own icons with the marker icon as the fallback", () => {
    const layer = pointLayer(editorWith({ marker: ICON, renderer: CATEGORIES }));
    expect(layer.layout).toMatchObject({
      "icon-image": [
        "match",
        ["to-string", ["get", "kind"]],
        "Hospital",
        "maki-hospital",
        "lucide-school",
      ],
    });
    expect(layer.paint).toMatchObject({
      "icon-color": [
        "match",
        ["to-string", ["get", "kind"]],
        "Hospital",
        "#111111",
        "Clinic",
        "#222222",
        "#999999",
      ],
    });
  });

  it("uses one icon for a graduated style and can grow it by class", () => {
    const layer = pointLayer(
      editorWith({ marker: { ...ICON, sizeScale: 3 }, renderer: GRADUATED }),
    );
    expect(layer.layout).toMatchObject({
      "icon-image": "lucide-school",
      "icon-size": [
        "case",
        ["==", ["get", "pop"], null],
        1,
        ["step", ["to-number", ["get", "pop"], 0], 1, 10, 2, 20, 3],
      ],
    });
    // Circles grow the same way through their radius.
    expect(sizeExpression(GRADUATED, 4, { ...ICON, kind: "circle", sizeScale: 2 })).toEqual([
      "case",
      ["==", ["get", "pop"], null],
      4,
      ["step", ["to-number", ["get", "pop"], 0], 4, 10, 6, 20, 8],
    ]);
  });

  it("emits valid MapLibre for every marker kind", () => {
    for (const marker of [
      ICON,
      { ...ICON, icon: "shape-star", kind: "shape" as const },
      { ...ICON, sizeScale: 2 },
    ]) {
      for (const renderer of [CATEGORIES, GRADUATED]) {
        expect(validateLayers(compileStyle(editorWith({ marker, renderer })).layers)).toEqual([]);
      }
    }
  });
});

describe("icon names", () => {
  it("reads every image a style can draw, not the category keys", () => {
    const style = compileStyle(editorWith({ marker: ICON, renderer: CATEGORIES }));
    expect(iconNamesOfStyle(style)).toEqual(["lucide-school", "maki-hospital"]);
    expect(
      iconNamesOfLayers([
        {
          layout: {
            "icon-image": [
              "case",
              ["has", "x"],
              ["image", "a-icon"],
              ["coalesce", ["image", "b-icon"], "c-icon"],
            ],
            "text-field": "label",
          },
          type: "symbol",
        },
        { layout: { "icon-image": "{legacy}" }, type: "symbol" },
        { paint: { "circle-color": "#000" }, type: "circle" },
      ]),
    ).toEqual(["a-icon", "b-icon", "c-icon"]);
  });

  it("swaps layers whose upload is gone for circles in the same color", () => {
    const style = compileStyle(
        editorWith({ marker: { ...ICON, icon: "user-abc123" }, renderer: CATEGORIES }),
      ),
      result = withIconFallback(style.layers, (name) => !name.startsWith("user-"));
    expect(result.missing).toEqual(["user-abc123"]);
    expect(result.layers[3]).toMatchObject({
      filter: style.layers[3].filter,
      paint: { "circle-color": colorExpression(CATEGORIES) },
      type: "circle",
    });
    expect(withIconFallback(style.layers, () => true).layers).toEqual(style.layers);
  });

  it("names uploads with the pattern the backend accepts", () => {
    expect(ICON_NAME_PATTERN.test("user-k17abc0def")).toBe(true);
    expect(ICON_NAME_PATTERN.test("maki-bank-jp")).toBe(true);
    expect(ICON_NAME_PATTERN.test("airport-15")).toBe(false);
  });
});

describe("tile path: markers", () => {
  it("keeps a single icon and falls back to the marker icon for per-category icons", () => {
    const single = tileLayers(compileStyle(editorWith({ marker: ICON })).layers);
    expect(single.dropped).toBe(false);
    expect(single.layers[3].layout).toMatchObject({ "icon-image": "lucide-school" });

    const perCategory = tileLayers(
      compileStyle(editorWith({ marker: ICON, renderer: CATEGORIES })).layers,
    );
    expect(perCategory.dropped).toBe(true);
    expect(perCategory.layers[3]).toMatchObject({
      layout: { "icon-image": "lucide-school" },
      // Colors still ride feature-state.
      paint: {
        "icon-color": [
          "match",
          ["to-string", ["feature-state", "kind"]],
          "Hospital",
          "#111111",
          "Clinic",
          "#222222",
          "#999999",
        ],
      },
      type: "symbol",
    });
  });

  it("falls back to the base icon size for class sizes", () => {
    const result = tileLayers(
      compileStyle(editorWith({ marker: { ...ICON, sizeScale: 2 }, renderer: GRADUATED })).layers,
    );
    expect(result.layers[3].layout).toMatchObject({ "icon-size": 1 });
  });
});

describe("import: unknown icons", () => {
  const layer = JSON.stringify({
    layout: { "icon-image": ["match", ["get", "k"], "a", "maki-park", "airport-15"] },
    type: "symbol",
  });

  it("lists icon names the app has no image for", () => {
    const result = importStyleJson(layer, (name) => name.startsWith("maki-"));
    expect(result).toEqual({
      errors: [expect.stringContaining('Unknown icon: "airport-15"')],
      ok: false,
    });
  });

  it("accepts known icons", () => {
    expect(importStyleJson(layer, () => true).ok).toBe(true);
  });
});

describe("legend: markers", () => {
  it("shows each class's marker", () => {
    const style = compileStyle(editorWith({ marker: ICON, renderer: CATEGORIES }));
    expect(legendClasses(style)).toEqual([
      { color: "#111111", icon: "maki-hospital", label: "Hospital" },
      { color: "#222222", icon: "lucide-school", label: "Clinic" },
      { color: "#999999", icon: "lucide-school", label: "Other" },
    ]);
    expect(legendClasses(compileStyle(editorWith({ renderer: CATEGORIES })))).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ icon: expect.any(String) })]),
    );
  });

  it("gives a single-symbol icon style its marker", () => {
    expect(singleMarkerIcon(compileStyle(editorWith({ marker: ICON })))).toBe("lucide-school");
    expect(singleMarkerIcon(compileStyle(editorWith({})))).toBeUndefined();
  });
});

describe("sdf", () => {
  it("puts the edge at alpha 192, fills the inside, and fades out over the radius", () => {
    // A 1px-wide vertical bar of full coverage in a 9×9 field.
    const size = 9,
      alpha = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 3; x <= 5; x += 1) {
        alpha[y * size + x] = 255;
      }
    }
    const field = sdfFromAlpha(alpha, size, size, 8),
      row = field.slice(4 * size, 5 * size);
    expect(row[4]).toBe(255);
    // One pixel outside the bar's last covered pixel: 1px from it.
    expect(row[6]).toBe(Math.round(255 - 255 * (1 / 8 + 0.25)));
    expect(row[0]).toBeLessThan(SDF_EDGE);
    expect(row[0]).toBeLessThan(row[1]);
  });

  it("pads the glyph by the buffer at each pixel ratio", () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(255),
      image = sdfImage(rgba, 4, 4, 2);
    expect(sdfParams(2)).toEqual({ buffer: 6, radius: 16 });
    expect(image.width).toBe(4 + 12);
    // Color channels stay black; the field is all in alpha.
    expect(image.data[0]).toBe(0);
  });
});

describe("sprite export", () => {
  it("packs used icons into a MapLibre manifest without overlaps", () => {
    const packed = packSprite(
      [
        { height: 30, name: "a", sdf: true, width: 30 },
        { height: 20, name: "b", sdf: false, width: 40 },
        { height: 30, name: "c", sdf: true, width: 30 },
      ],
      1,
    );
    expect(Object.keys(packed.manifest)).toEqual(["a", "b", "c"]);
    expect(packed.manifest["a"]).toMatchObject({ height: 30, pixelRatio: 1, sdf: true, width: 30 });
    expect(packed.manifest["b"]).not.toHaveProperty("sdf");
    const boxes = Object.values(packed.manifest);
    for (const [index, left] of boxes.entries()) {
      expect(left.x + left.width).toBeLessThanOrEqual(packed.width);
      expect(left.y + left.height).toBeLessThanOrEqual(packed.height);
      for (const right of boxes.slice(index + 1)) {
        const apart =
          left.x + left.width <= right.x ||
          right.x + right.width <= left.x ||
          left.y + left.height <= right.y ||
          right.y + right.height <= left.y;
        expect(apart).toBe(true);
      }
    }
    expect(spriteReadme("parks-style.json", 3)).toContain("the 3 icons the layers use");
  });
});

describe("built-in sprite", () => {
  const dir = new URL("../../../../public/sprites/layer-styles/", import.meta.url),
    readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8")),
    catalog = readJson("catalog.json") as {
      glyphPx: number;
      icons: Array<{ name: string; family: string }>;
    };

  it("matches the catalog at both pixel ratios, within the sheet, all SDF", () => {
    expect(catalog.glyphPx).toBe(ICON_GLYPH_PX);
    const names = catalog.icons.map((icon) => icon.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(ICON_NAME_PATTERN.test(name)).toBe(true);
    }
    for (const suffix of ["", "@2x"]) {
      const manifest = readJson(`sprite${suffix}.json`) as Record<
          string,
          { x: number; y: number; width: number; height: number; pixelRatio: number; sdf: boolean }
        >,
        png = PNG.sync.read(readFileSync(new URL(`sprite${suffix}.png`, dir)));
      expect(Object.keys(manifest).toSorted()).toEqual(names.toSorted());
      for (const entry of Object.values(manifest)) {
        expect(entry.sdf).toBe(true);
        expect(entry.pixelRatio).toBe(suffix === "" ? 1 : 2);
        expect(entry.x + entry.width).toBeLessThanOrEqual(png.width);
        expect(entry.y + entry.height).toBeLessThanOrEqual(png.height);
      }
    }
  });

  it("ships the seven shapes and keeps the icon set curated", () => {
    const families = (family: string) =>
      catalog.icons.filter((icon) => icon.family === family).map((icon) => icon.name);
    expect(families("shape")).toEqual([
      "shape-circle",
      "shape-square",
      "shape-triangle",
      "shape-diamond",
      "shape-star",
      "shape-cross",
      "shape-pin",
    ]);
    expect(families("lucide")).toContain("lucide-map-pin");
    expect(families("maki")).toContain("maki-hospital");
    expect(catalog.icons.length).toBeLessThan(600);
  });
});

describe("uploads", () => {
  it("accepts small SVG and PNG files only", () => {
    expect(checkUploadFile({ name: "a.svg", size: 100, type: "image/svg+xml" })).toEqual({
      kind: "svg",
      ok: true,
    });
    expect(checkUploadFile({ name: "a.PNG", size: 100, type: "" })).toEqual({
      kind: "png",
      ok: true,
    });
    expect(checkUploadFile({ name: "a.gif", size: 100, type: "image/gif" }).ok).toBe(false);
    expect(checkUploadFile({ name: "a.svg", size: 0, type: "image/svg+xml" }).ok).toBe(false);
    expect(
      checkUploadFile({ name: "a.png", size: ICON_LIMITS.fileBytes + 1, type: "image/png" }),
    ).toEqual({ error: "Icons can be 256 KB at most.", ok: false });
  });

  it("refuses PNGs over 128px", () => {
    expect(checkPngSize(128, 64)).toBeUndefined();
    expect(checkPngSize(129, 64)).toMatch(/128×128/);
  });

  it("reads an SVG's size and refuses DOCTYPEs, entities, and non-SVG text", () => {
    expect(inspectSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 15 10"/>')).toEqual({
      height: 10,
      ok: true,
      width: 15,
    });
    expect(inspectSvg("<svg width='24px' height=\"12\"><path/></svg>")).toEqual({
      height: 12,
      ok: true,
      width: 24,
    });
    expect(inspectSvg('<!DOCTYPE svg [<!ENTITY a "x">]><svg viewBox="0 0 1 1"/>').ok).toBe(false);
    expect(inspectSvg("<html></html>").ok).toBe(false);
    expect(inspectSvg("<svg><path/></svg>").ok).toBe(false);
  });

  it("fits into the glyph box keeping the aspect ratio", () => {
    expect(fitWithin(15, 10, 48)).toEqual({ height: 32, width: 48 });
    expect(fitWithin(1, 400, 48)).toEqual({ height: 48, width: 1 });
  });

  it("names icons after their file", () => {
    expect(iconLabelFromFileName("fire_hydrant-red.svg")).toBe("fire hydrant red");
    expect(iconLabelFromFileName(".svg")).toBe("Icon");
  });
});
