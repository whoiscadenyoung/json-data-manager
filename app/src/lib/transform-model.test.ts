import { describe, expect, it } from "vitest";

import {
  draftToSpec,
  emptyBuilderOperation,
  firstIncompleteReason,
  fromBuilderOperation,
  isLookupComplete,
  matchStatLine,
  toBuilderOperation,
  truncateOrphanKeys,
} from "./transform-model";

function completeOperation() {
  return {
    baseKey: "GrantId",
    kind: "lookup" as const,
    lookupDatasetId: "grants",
    lookupKey: "GrantId",
    namespace: "Grants",
  };
}

describe("builder operations", () => {
  it("round-trips through the builder shape, preserving omit-means-all", () => {
    expect(fromBuilderOperation(toBuilderOperation({ ...completeOperation() }))).toStrictEqual(
      completeOperation(),
    );
    expect(
      fromBuilderOperation(toBuilderOperation({ ...completeOperation(), fields: undefined })),
    ).toStrictEqual(completeOperation());
  });

  it("a stored op with explicit fields loads back in pick mode", () => {
    const builder = toBuilderOperation({ ...completeOperation(), fields: ["Status"] });

    expect(builder.fieldsMode).toBe("pick");
    expect(fromBuilderOperation(builder).fields).toStrictEqual(["Status"]);
  });

  it("firstIncompleteReason names the first blocking gap, in the person's terms", () => {
    const empty = emptyBuilderOperation();

    expect(firstIncompleteReason([empty])).toContain("related dataset");
    expect(firstIncompleteReason([{ ...empty, lookupDatasetId: "grants" }])).toContain(
      "key column on this dataset",
    );
    expect(
      firstIncompleteReason([{ ...empty, baseKey: "GrantId", lookupDatasetId: "grants" }]),
    ).toContain("key column on the related dataset");
    expect(
      firstIncompleteReason([
        { ...empty, baseKey: "GrantId", fieldsMode: "pick", fields: [], lookupDatasetId: "grants", lookupKey: "GrantId" },
      ]),
    ).toContain("pick at least one field");
    expect(firstIncompleteReason([toBuilderOperation(completeOperation())])).toBeUndefined();
    expect(isLookupComplete(toBuilderOperation(completeOperation()))).toBe(true);
    expect(isLookupComplete(emptyBuilderOperation())).toBe(false);
  });

  it("draftToSpec keeps only complete operations, in order, and records the dependencies", () => {
    const spec = draftToSpec("items", [emptyBuilderOperation(), toBuilderOperation(completeOperation())]);

    expect(spec.sourceDatasetId).toBe("items");
    expect(spec.operations).toStrictEqual([completeOperation()]);
  });
});

describe("matchStatLine", () => {
  it("renders the §6 stat line from full-dataset diagnostics", () => {
    expect(
      matchStatLine(
        {
          droppedRows: 0,
          matchedRows: 8700,
          totalSourceRows: 10000,
          unmatchedKeys: Array.from({ length: 214 }, () => "x"),
          unmatchedRows: 1300,
        },
        "GrantId",
      ),
    ).toBe("87% matched; 1300 orphan GrantId");
  });

  it("rounds, keeps the orphan count row-true, and answers an empty dataset without a division", () => {
    expect(
      matchStatLine(
        {
          droppedRows: 0,
          matchedRows: 2,
          totalSourceRows: 3,
          unmatchedKeys: ["X", "Y"],
          unmatchedRows: 1,
        },
        "Id",
      ),
    ).toBe("67% matched; 1 orphan Id");
    expect(matchStatLine(
      { droppedRows: 0, matchedRows: 0, totalSourceRows: 0, unmatchedKeys: [], unmatchedRows: 0 },
      "Id",
    )).toBe("No rows to match yet.");
  });
});

describe("truncateOrphanKeys", () => {
  it("shows the first few and counts the rest", () => {
    const truncated = truncateOrphanKeys(["a", "b", "c", "d", "e", "f", "g"], 5);

    expect(truncated).toStrictEqual({ remaining: 2, shown: ["a", "b", "c", "d", "e"] });
    expect(truncateOrphanKeys(["a"], 5)).toStrictEqual({ remaining: 0, shown: ["a"] });
    expect(truncateOrphanKeys([], 5)).toStrictEqual({ remaining: 0, shown: [] });
  });
});
