import { describe, expect, it } from "vitest";

import type { AppPage } from "#convex/appBuilder/validators";

import {
  nextPageTitle,
  pagesWithoutDataset,
  removePage,
  resolvePage,
  shiftPage,
  updatePage,
} from "./pages";

const page = (id: string, title = id): AppPage => ({
  id,
  layout: "contained",
  title,
  widgets: [],
});

describe("pages", () => {
  it("names new pages after the next free number", () => {
    expect(nextPageTitle([page("a", "Page 1")])).toBe("Page 2");
    expect(nextPageTitle([page("a", "Page 2"), page("b", "Map")])).toBe("Page 3");
  });

  it("never removes the last page", () => {
    expect(removePage([page("a")], "a").map((p) => p.id)).toEqual(["a"]);
    expect(removePage([page("a"), page("b")], "a").map((p) => p.id)).toEqual(["b"]);
  });

  it("shifts pages left and right within bounds", () => {
    const pages = [page("a"), page("b"), page("c")];
    expect(shiftPage(pages, "c", -1).map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(shiftPage(pages, "c", 1).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("updates one page and resolves unknown ids to the first page", () => {
    const pages = updatePage([page("a"), page("b")], "b", (p) => ({ ...p, layout: "fullscreen" }));
    expect(pages[1].layout).toBe("fullscreen");
    expect(resolvePage(pages, "zzz").id).toBe("a");
    expect(resolvePage(pages, "b").id).toBe("b");
  });

  it("removing a dataset clears it from every page", () => {
    const pages: AppPage[] = [
      {
        ...page("a"),
        widgets: [{ columns: [], datasetId: "d", h: 4, id: "t", kind: "table", w: 6 }],
      },
      { ...page("b"), widgets: [{ datasetIds: ["d", "e"], h: 6, id: "m", kind: "map", w: 6 }] },
    ];
    const next = pagesWithoutDataset(pages, "d");
    expect(next[0].widgets).toEqual([]);
    expect(next[1].widgets).toEqual([{ datasetIds: ["e"], h: 6, id: "m", kind: "map", w: 6 }]);
  });
});
