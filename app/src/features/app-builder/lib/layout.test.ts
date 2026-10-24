import { describe, expect, it } from "vitest";

import type { Widget } from "#convex/appBuilder/validators";

import { moveWidget, resizeWidget, spanFromDrag, withoutDataset } from "./layout";

const text = (id: string): Widget => ({ body: "", h: 2, id, kind: "text", w: 12 });

describe("layout", () => {
  it("moves widgets within the list", () => {
    const moved = moveWidget([text("a"), text("b"), text("c")], 0, 2);
    expect(moved.map((widget) => widget.id)).toEqual(["b", "c", "a"]);
  });

  it("clamps resizes to the grid", () => {
    const [widget] = resizeWidget([text("a")], "a", { h: 40, w: 0 });
    expect(widget).toMatchObject({ h: 12, w: 1 });
  });

  it("snaps a drag to whole tracks", () => {
    expect(spanFromDrag(6, 170, 80, 12)).toBe(8);
    expect(spanFromDrag(6, -1000, 80, 12)).toBe(1);
  });

  it("removing a dataset drops its widgets and map layers", () => {
    const widgets: Widget[] = [
      { datasetIds: ["d1", "d2"], h: 6, id: "m", kind: "map", w: 8 },
      { columns: [], datasetId: "d1", h: 6, id: "t", kind: "table", w: 12 },
      text("x"),
    ];
    expect(withoutDataset(widgets, "d1")).toEqual([
      { datasetIds: ["d2"], h: 6, id: "m", kind: "map", w: 8 },
      text("x"),
    ]);
  });
});
