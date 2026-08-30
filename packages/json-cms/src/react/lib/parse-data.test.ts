import { describe, expect, test } from "vitest";
import { parseDataRows } from "./parse-data.js";

describe("parseDataRows", () => {
  test("parses a JSON array", () => {
    const { rows, errors } = parseDataRows('[{"a":1},{"a":2}]');
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("parses a pretty-printed JSON array", () => {
    const { rows, errors } = parseDataRows('[\n  { "a": 1 },\n  { "a": 2 }\n]');
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  test("wraps a single top-level object as a one-row dataset", () => {
    const { rows, errors } = parseDataRows('{ "a": 1 }');
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ a: 1 }]);
  });

  test("parses JSONL (one object per line)", () => {
    const { rows, errors } = parseDataRows('{"a":1}\n{"a":2}\n{"a":3}');
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  test("skips blank lines in JSONL", () => {
    const { rows, errors } = parseDataRows('{"a":1}\n\n\n{"a":2}\n');
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  test("collects per-line errors without discarding valid rows", () => {
    const { rows, errors } = parseDataRows('{"a":1}\nnot json\n{"a":2}');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(errors).toEqual([{ line: 2, message: "Line is not valid JSON." }]);
  });

  test("returns empty result for blank input", () => {
    expect(parseDataRows("   \n  ")).toEqual({ rows: [], errors: [] });
  });

  test("rejects a bare primitive", () => {
    const { rows, errors } = parseDataRows("42");
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
