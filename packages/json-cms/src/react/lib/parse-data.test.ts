import { describe, expect, it } from "vitest";

import { parseDataRows } from "./parse-data.js";

describe(parseDataRows, () => {
  it("parses a JSON array", () => {
    const { rows, errors } = parseDataRows('[{"a":1},{"a":2}]');
    expect(errors).toStrictEqual([]);
    expect(rows).toStrictEqual([{ a: 1 }, { a: 2 }]);
  });

  it("parses a pretty-printed JSON array", () => {
    const { rows, errors } = parseDataRows('[\n  { "a": 1 },\n  { "a": 2 }\n]');
    expect(errors).toStrictEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("wraps a single top-level object as a one-row dataset", () => {
    const { rows, errors } = parseDataRows('{ "a": 1 }');
    expect(errors).toStrictEqual([]);
    expect(rows).toStrictEqual([{ a: 1 }]);
  });

  it("parses JSONL (one object per line)", () => {
    const { rows, errors } = parseDataRows('{"a":1}\n{"a":2}\n{"a":3}');
    expect(errors).toStrictEqual([]);
    expect(rows).toStrictEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("skips blank lines in JSONL", () => {
    const { rows, errors } = parseDataRows('{"a":1}\n\n\n{"a":2}\n');
    expect(errors).toStrictEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("collects per-line errors without discarding valid rows", () => {
    const { rows, errors } = parseDataRows('{"a":1}\nnot json\n{"a":2}');
    expect(rows).toStrictEqual([{ a: 1 }, { a: 2 }]);
    expect(errors).toStrictEqual([{ line: 2, message: "Line is not valid JSON." }]);
  });

  it("returns empty result for blank input", () => {
    expect(parseDataRows("   \n  ")).toStrictEqual({ errors: [], rows: [] });
  });

  it("rejects a bare primitive", () => {
    const { rows, errors } = parseDataRows("42");
    expect(rows).toStrictEqual([]);
    expect(errors).toHaveLength(1);
  });
});
