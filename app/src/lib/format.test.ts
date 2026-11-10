import { describe, expect, it } from "vitest";

import { formatPropertyValue } from "./format";

describe("formatPropertyValue", () => {
  it("renders the null literal as an em dash", () => {
    expect(formatPropertyValue(null)).toBe("—");
    expect(formatPropertyValue(undefined)).toBe("—");
  });

  it("passes primitives through", () => {
    expect(formatPropertyValue("ready")).toBe("ready");
    expect(formatPropertyValue(42)).toBe("42");
    expect(formatPropertyValue(true)).toBe("true");
  });

  it("stringifies a plain object", () => {
    expect(formatPropertyValue({ a: 1 })).toBe('{"a":1}');
  });

  it("joins a collect-join array readably (ADR 0026) — primitives and nulls", () => {
    expect(formatPropertyValue([143, 134, 135])).toBe("143, 134, 135");
    expect(formatPropertyValue(["north", "south"])).toBe("north, south");
    expect(formatPropertyValue(["open", null])).toBe("open, —");
  });

  it("stringifies object cells inside an array (no primitive form to join)", () => {
    expect(formatPropertyValue([{ id: 1 }, { id: 2 }])).toBe('{"id":1}, {"id":2}');
  });
});
