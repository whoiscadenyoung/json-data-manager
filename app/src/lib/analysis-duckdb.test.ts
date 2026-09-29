import { describe, expect, it } from "vitest";

import { normalizeArrowValue } from "./analysis-duckdb";

/**
 * The pure cell-normalization policy of the DuckDB engine handle (the
 * `SqlEngine` impl's query leg). The WASM engine itself can't run under
 * vitest (no worker/browser WASM in the node environment), so the
 * information_schema drop dance and memory_limit setting stay
 * build-verified only — this file pins the one piece of that module that is
 * pure policy: what an Arrow cell becomes in serializable plain data.
 */
describe("normalizeArrowValue — Arrow cells into serializable plain data", () => {
  it("narrows DuckDB's BigInt aggregates (COUNT/sum) to safe numbers", () => {
    expect(normalizeArrowValue(42n)).toBe(42);
    expect(normalizeArrowValue(0n)).toBe(0);
    expect(normalizeArrowValue(-9007199254740991n)).toBe(-9007199254740991);
  });

  it("stringifies BigInt beyond the safe range instead of silently losing precision", () => {
    expect(normalizeArrowValue(9007199254740992n)).toBe("9007199254740992");
    expect(normalizeArrowValue(-9007199254740993n)).toBe("-9007199254740993");
  });

  it("passes every non-BigInt value through untouched", () => {
    expect(normalizeArrowValue("aldine")).toBe("aldine");
    expect(normalizeArrowValue(3.14)).toBe(3.14);
    expect(normalizeArrowValue(null)).toBe(null);
    expect(normalizeArrowValue(undefined)).toBe(undefined);
    expect(normalizeArrowValue(true)).toBe(true);
  });
});
