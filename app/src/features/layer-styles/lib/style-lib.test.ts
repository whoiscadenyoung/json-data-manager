import { describe, expect, it } from "vitest";

import type { StyleEditor } from "#convex/layerStyles/validators";

import { classBreaks, distinctValues, numericValues } from "./classify";
import { colorExpression, compileStyle, defaultEditor } from "./compile";
import { exportStyleJson, importStyleJson, validateLayers } from "./exchange";
import { fieldsOfStyle, tileLayers } from "./expressions";
import { legendClasses } from "./legend";
import { NO_DATA_COLOR, rampColors } from "./palettes";
import { bestCategoryField, graduatedRenderer } from "./renderers";

function editorWith(renderer: StyleEditor["renderer"]): StyleEditor {
  return { ...defaultEditor("#3b82f6"), renderer };
}

describe("classify", () => {
  it("counts distinct values by their string form, most frequent first", () => {
    expect(distinctValues(["a", "b", "a", 3, "3", null, "", { x: 1 }, true])).toEqual([
      { count: 2, value: 3 },
      { count: 2, value: "a" },
      { count: 1, value: "b" },
      { count: 1, value: true },
    ]);
  });

  it("keeps finite numbers and numeric strings", () => {
    expect(numericValues([1, "2.5", "x", "", Number.NaN, null, Infinity])).toEqual([1, 2.5]);
  });

  it("builds equal-interval breaks", () => {
    expect(classBreaks([0, 10, 20, 30, 40], 4, "equal")).toEqual([10, 20, 30]);
  });

  it("builds quantile breaks and drops duplicates", () => {
    expect(classBreaks([1, 2, 3, 4, 5, 6, 7, 8], 4, "quantile")).toEqual([3, 5, 7]);
    expect(classBreaks([1, 1, 1, 1, 2], 4, "quantile")).toEqual([2]);
  });

  it("returns no breaks for constant or empty data", () => {
    expect(classBreaks([5, 5, 5], 3, "equal")).toEqual([]);
    expect(classBreaks([], 3, "quantile")).toEqual([]);
  });
});

describe("palettes", () => {
  it("interpolates a ramp to any class count, light to dark", () => {
    const colors = rampColors("blues", 5);
    expect(colors).toHaveLength(5);
    expect(colors[0]).toBe("#eff3ff");
    expect(colors[4]).toBe("#08306b");
  });
});

describe("compile", () => {
  it("reproduces the default look for a single symbol", () => {
    const style = compileStyle(defaultEditor("#ef4444"));
    expect(style.layers.map((layer) => layer.type)).toEqual(["fill", "line", "line", "circle"]);
    expect(style.layers[0].paint).toEqual({ "fill-color": "#ef4444", "fill-opacity": 0.2 });
    expect(validateLayers(style.layers)).toEqual([]);
  });

  it("matches categories on their string form, deduplicated", () => {
    const expression = colorExpression({
      categories: [
        { color: "#111111", value: "A" },
        { color: "#222222", value: 3 },
        { color: "#333333", value: "3" },
      ],
      field: "kind",
      kind: "categorical",
      otherColor: "#999999",
    });
    expect(expression).toEqual([
      "match",
      ["to-string", ["get", "kind"]],
      "A",
      "#111111",
      "3",
      "#222222",
      "#999999",
    ]);
  });

  it("steps graduated colors with a no-data case", () => {
    const expression = colorExpression({
      breaks: [10, 20],
      colors: ["#a", "#b", "#c"],
      field: "pop",
      kind: "graduated",
      method: "equal",
      ramp: "blues",
    });
    expect(expression).toEqual([
      "case",
      ["==", ["get", "pop"], null],
      NO_DATA_COLOR,
      ["step", ["to-number", ["get", "pop"], 0], "#a", 10, "#b", 20, "#c"],
    ]);
  });

  it("emits valid MapLibre layers for every renderer, labels, and zoom range", () => {
    const style = compileStyle({
      ...editorWith({
        breaks: [10],
        colors: ["#eff3ff", "#08306b"],
        field: "pop",
        kind: "graduated",
        method: "quantile",
        ramp: "blues",
      }),
      label: { color: "#111111", field: "name", haloColor: "#ffffff", size: 12 },
      maxzoom: 18,
      minzoom: 4,
    });
    expect(style.layers.at(-1)).toMatchObject({ minzoom: 4, maxzoom: 18, type: "symbol" });
    expect(validateLayers(style.layers)).toEqual([]);
    expect(fieldsOfStyle(style)).toEqual(["name", "pop"]);
  });
});

describe("tile path", () => {
  it("moves paint reads onto feature-state and drops data-driven layout/filter layers", () => {
    const style = compileStyle({
        ...editorWith({
          categories: [{ color: "#111111", value: "A" }],
          field: "kind",
          kind: "categorical",
          otherColor: "#999999",
        }),
        label: { color: "#111111", field: "name", haloColor: "#ffffff", size: 12 },
      }),
      result = tileLayers(style);
    expect(result.dropped).toBe(true);
    expect(result.layers.map((layer) => layer.type)).toEqual(["fill", "line", "line", "circle"]);
    expect(result.layers[0].paint).toMatchObject({
      "fill-color": ["match", ["to-string", ["feature-state", "kind"]], "A", "#111111", "#999999"],
    });
    // Geometry-type filters read no data and survive.
    expect(result.layers[0].filter).toEqual(style.layers[0].filter);
  });
});

describe("legend", () => {
  it("lists category classes plus Other", () => {
    const style = compileStyle(
      editorWith({
        categories: [{ color: "#111111", value: "A" }],
        field: "kind",
        kind: "categorical",
        otherColor: "#999999",
      }),
    );
    expect(legendClasses(style)).toEqual([
      { color: "#111111", label: "A" },
      { color: "#999999", label: "Other" },
    ]);
  });

  it("labels graduated ranges", () => {
    const style = compileStyle(
      editorWith({
        breaks: [10, 20],
        colors: ["#a", "#b", "#c"],
        field: "pop",
        kind: "graduated",
        method: "equal",
        ramp: "blues",
      }),
    );
    expect(legendClasses(style)).toEqual([
      { color: "#a", label: "< 10" },
      { color: "#b", label: "10 – 20" },
      { color: "#c", label: "≥ 20" },
      { color: NO_DATA_COLOR, label: "No data" },
    ]);
  });

  it("has no classes for single or custom styles", () => {
    expect(legendClasses(compileStyle(defaultEditor("#000000")))).toBeUndefined();
    expect(legendClasses({ layers: [{ type: "fill" }], version: 1 })).toBeUndefined();
  });
});

describe("exchange", () => {
  it("round-trips through MapLibre JSON as a custom style", () => {
    const style = compileStyle(defaultEditor("#22c55e")),
      json = exportStyleJson(style, "Bike Lanes!"),
      exported = JSON.parse(json) as Array<Record<string, unknown>>;
    expect(exported[0]).toMatchObject({ id: "bike-lanes-fill-1", source: "dataset" });
    const imported = importStyleJson(json);
    expect(imported).toEqual({ ok: true, style: { layers: style.layers, version: 1 } });
  });

  it("accepts a single layer or a whole style.json and drops wiring fields", () => {
    const single = importStyleJson(
      JSON.stringify({ id: "x", paint: { "circle-radius": 3 }, source: "y", type: "circle" }),
    );
    expect(single).toEqual({
      ok: true,
      style: { layers: [{ paint: { "circle-radius": 3 }, type: "circle" }], version: 1 },
    });
    const whole = importStyleJson(
      JSON.stringify({ layers: [{ id: "a", type: "fill" }], sources: {}, version: 8 }),
    );
    expect(whole).toMatchObject({ ok: true });
  });

  it("rejects unsupported types, bad JSON, and invalid paint", () => {
    expect(importStyleJson("{")).toEqual({ errors: ["That isn't valid JSON."], ok: false });
    expect(importStyleJson(JSON.stringify({ type: "raster" }))).toMatchObject({ ok: false });
    const invalid = importStyleJson(
      JSON.stringify({ paint: { "fill-opacity": "lots" }, type: "fill" }),
    );
    expect(invalid.ok).toBe(false);
  });
});

describe("renderers", () => {
  const parks = [
    { area: 100, id: "a", region: "West" },
    { area: 200, id: "b", region: "West" },
    { area: 300, id: "c", region: "East" },
  ];

  it("starts categories on a low-cardinality text field, not the alphabetically first", () => {
    expect(bestCategoryField(parks, ["area", "id", "region"])).toBe("region");
    expect(bestCategoryField([], [])).toBeUndefined();
  });

  it("builds graduated colors one longer than the breaks", () => {
    const renderer = graduatedRenderer("area", [100, 200, 300, 400], {
      classes: 4,
      method: "equal",
      ramp: "reds",
    });
    expect(renderer).toMatchObject({ breaks: [175, 250, 325], kind: "graduated" });
    expect(renderer.kind === "graduated" && renderer.colors).toHaveLength(4);
  });
});
