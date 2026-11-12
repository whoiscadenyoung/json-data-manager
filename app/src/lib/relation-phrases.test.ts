import { describe, expect, it } from "vitest";

import { largestRelatedSet, relationEndsOf, relationPhrase } from "./relation-phrases";
import type { DatasetRelationRow } from "./store/relations";

function relation(
  id: string,
  from: string,
  to: string,
  kind: "key" | "spatial",
  config: unknown,
): DatasetRelationRow {
  return {
    cardinality: "1-N",
    config,
    createdAt: "",
    createdBy: "",
    fromDataset: from,
    id,
    kind,
    toDataset: to,
    updatedAt: "",
  };
}

const relations = [
  relation("r1", "awards", "corridors", "key", { fromKey: "UEI", toKey: "UEI" }),
  relation("r2", "jurisdictions", "awards", "key", { fromKey: "GEOID", toKey: "Juris_ID" }),
  relation("r3", "corridors", "parks", "spatial", { direction: "from", predicate: "intersects" }),
  relation("r4", "other", "elsewhere", "key", { fromKey: "a", toKey: "b" }),
];

const titles = new Map([
  ["awards", "FY22 IG Awards"],
  ["corridors", "FY23 IG Project Corridors"],
  ["jurisdictions", "Jurisdictions"],
  ["parks", "Parks"],
]);
const titleOf = (id: string): string => titles.get(id) ?? id;

describe("relationEndsOf", () => {
  it("lists both directions from this dataset's side", () => {
    expect(relationEndsOf(relations, "awards")).toStrictEqual([
      { how: "via UEI", otherId: "corridors", relationId: "r1" },
      { how: "via Juris_ID ↔ GEOID", otherId: "jurisdictions", relationId: "r2" },
    ]);
  });

  it("phrases spatial relations by location", () => {
    expect(relationEndsOf(relations, "parks")).toStrictEqual([
      { how: "by location (intersects)", otherId: "corridors", relationId: "r3" },
    ]);
  });

  it("bounds the other end to a set (the map's layers)", () => {
    expect(
      relationEndsOf(relations, "awards", new Set(["awards", "corridors"])).map(
        (end) => end.otherId,
      ),
    ).toStrictEqual(["corridors"]);
  });

  it("tolerates a shapeless config", () => {
    expect(relationEndsOf([relation("x", "a", "b", "key", null)], "a")[0].how).toBe("");
  });
});

describe("relationPhrase", () => {
  it("names the other end and the key", () => {
    const [end] = relationEndsOf(relations, "awards");
    expect(relationPhrase(end, titleOf)).toBe("Related to FY23 IG Project Corridors via UEI");
  });

  it("drops the key part when unknown", () => {
    expect(relationPhrase({ how: "", otherId: "parks", relationId: "x" }, titleOf)).toBe(
      "Related to Parks",
    );
  });
});

describe("largestRelatedSet (#342)", () => {
  const rel = (id: string, from: string, to: string): DatasetRelationRow =>
    ({
      cardinality: "1-N",
      config: {},
      fromDataset: from,
      id,
      kind: "key",
      toDataset: to,
    }) as DatasetRelationRow;

  it("proposes the connected set when two or more ids relate", () => {
    expect(
      largestRelatedSet([rel("r1", "a", "b"), rel("r2", "b", "c")], ["c", "a", "b"]),
    ).toStrictEqual(["a", "b", "c"]);
  });

  it("keeps two disjoint pairs apart and proposes the larger one", () => {
    const relations = [rel("r1", "a", "b"), rel("r2", "c", "d"), rel("r3", "c", "e")];
    expect(largestRelatedSet(relations, ["a", "b", "c", "d", "e"])).toStrictEqual(["c", "d", "e"]);
  });

  it("proposes nothing when no id relates to another", () => {
    expect(largestRelatedSet([rel("r1", "a", "gone")], ["a", "b"])).toStrictEqual([]);
    expect(largestRelatedSet([], ["a", "b"])).toStrictEqual([]);
  });

  it("ignores self-relations and out-of-set ends", () => {
    expect(largestRelatedSet([rel("r1", "a", "a")], ["a", "b"])).toStrictEqual([]);
    expect(
      largestRelatedSet([rel("r1", "a", "b"), rel("r2", "b", "gone")], ["a", "b"]),
    ).toStrictEqual(["a", "b"]);
  });
});
