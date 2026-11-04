import { describe, expect, it } from "vitest";

import { APP_LIMITS, appPagesOf, firstPage, widgetDatasetIds } from "./content";
import type { AppPage, Widget } from "./content";

describe("widgetDatasetIds", () => {
  it("reads a map's layer list", () => {
    const widget: Widget = { datasetIds: ["a", "b"], h: 1, id: "w1", kind: "map", w: 4 };
    expect(widgetDatasetIds(widget)).toStrictEqual(["a", "b"]);
  });

  it("reads a text block as referencing nothing", () => {
    const widget: Widget = { body: "hi", h: 1, id: "w1", kind: "text", w: 4 };
    expect(widgetDatasetIds(widget)).toStrictEqual([]);
  });

  it("reads single-dataset widgets as their one reference", () => {
    const stat: Widget = {
      aggregate: "count",
      datasetId: "d1",
      h: 1,
      id: "w1",
      kind: "stat",
      w: 3,
    };
    const table: Widget = { columns: [], datasetId: "d2", h: 1, id: "w2", kind: "table", w: 6 };
    const chart: Widget = {
      aggregate: "count",
      chartType: "bar",
      datasetId: "d3",
      h: 1,
      id: "w3",
      kind: "chart",
      limit: 10,
      sort: "value-desc",
      w: 6,
    };
    expect(widgetDatasetIds(stat)).toStrictEqual(["d1"]);
    expect(widgetDatasetIds(table)).toStrictEqual(["d2"]);
    expect(widgetDatasetIds(chart)).toStrictEqual(["d3"]);
  });
});

describe("appPagesOf", () => {
  it("reads a null column as one empty first page", () => {
    expect(appPagesOf(null)).toStrictEqual([firstPage()]);
  });

  it("reads an empty array as one empty first page (the 0014 default)", () => {
    expect(appPagesOf([])).toStrictEqual([firstPage()]);
  });

  it("reads undefined the same way", () => {
    expect(appPagesOf(undefined)).toStrictEqual([firstPage()]);
  });

  it("passes stored pages through", () => {
    const pages: AppPage[] = [{ id: "p2", layout: "fullscreen", title: "Map", widgets: [] }];
    expect(appPagesOf(pages)).toBe(pages);
  });

  it("bounds a first page inside the grid constants", () => {
    const page = firstPage();
    expect(page.id).toBe("page-1");
    expect(page.layout).toBe("contained");
    expect(APP_LIMITS.columns).toBe(12);
  });
});
