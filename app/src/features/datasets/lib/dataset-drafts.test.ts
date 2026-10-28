import { describe, expect, it } from "vitest";

import { withDrafts } from "./dataset-drafts";

type Row = { _id: string; title: string };

const published: Row[] = [
  { _id: "p1", title: "Published one" },
  { _id: "p2", title: "Published two" },
];
const drafts: Row[] = [{ _id: "d1", title: "Draft one" }];

describe("withDrafts (roadmap 5a, #99)", () => {
  it("toggle off returns exactly the published list — the browser shows published by default", () => {
    const result = withDrafts(published, drafts, false);
    expect(result).toEqual(published);
    // No copy, no merge: identical rows, drafts never touched.
    expect(result).toBe(published);
  });

  it("toggle on with drafts loaded merges, newest semantics downstream, no duplicate ids", () => {
    const merged = withDrafts(published, drafts, true);
    expect(merged.map((row) => row._id)).toEqual(["p1", "p2", "d1"]);
    const ids = new Set(merged.map((row) => row._id));
    expect(ids.size).toBe(merged.length);
  });

  it("toggle on while the drafts read is still loading falls back to published only", () => {
    const result = withDrafts(published, undefined, true);
    expect(result).toEqual(published);
    expect(result).toBe(published);
  });

  it("undefined published list (initial load) yields an empty array in both toggle states", () => {
    expect(withDrafts(undefined, undefined, false)).toEqual([]);
    expect(withDrafts(undefined, drafts, true)).toEqual([]);
  });

  it("drops a draft id the published read already carries (server-disjointness guard)", () => {
    const overlapping: Row[] = [...published, { _id: "d1", title: "Also published?!" }];
    const merged = withDrafts(overlapping, drafts, true);
    expect(merged.filter((row) => row._id === "d1")).toHaveLength(1);
    expect(merged).toHaveLength(3);
  });
});
