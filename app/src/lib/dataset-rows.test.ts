import { describe, expect, it } from "vitest";

import { type DatasetEntryRow, entryDataRecord } from "./dataset-rows";

function entry(data: unknown): DatasetEntryRow {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- probing non-object data on purpose.
  return { _creationTime: 0, _id: "e1", data: data as DatasetEntryRow["data"], schemaId: "s1" };
}

describe("entryDataRecord", () => {
  it("adapts object data as the engine's record and non-object data as keyless", () => {
    expect(entryDataRecord(entry({ a: 1 }))).toStrictEqual({ a: 1 });
    expect(entryDataRecord(entry(null))).toStrictEqual({});
    expect(entryDataRecord(entry([1, 2]))).toStrictEqual({});
    expect(entryDataRecord(entry("text"))).toStrictEqual({});
  });
});
