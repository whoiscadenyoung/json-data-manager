import { describe, expect, it } from "vitest";

import { sanitizeSheetName } from "./export";

describe("sanitizeSheetName — workbook-unique sheet names (#133 item 14)", () => {
  it("loops the dedupe so a repeated title never repeats a generated name", () => {
    // The old single-pass dedupe returned "A-3" twice here (the suffix
    // landed on an already-taken name) — two sheets with one name.
    const used = new Set<string>();
    expect(sanitizeSheetName("A", used)).toBe("A");
    expect(sanitizeSheetName("A-3", used)).toBe("A-3");
    expect(sanitizeSheetName("A", used)).toBe("A-4");
    expect(sanitizeSheetName("A", used)).toBe("A-5");
    expect(used).toEqual(new Set(["A", "A-3", "A-4", "A-5"]));
  });

  it("folds case — Excel reads sheet names case-insensitively", () => {
    const used = new Set<string>();
    expect(sanitizeSheetName("Grants", used)).toBe("Grants");
    expect(sanitizeSheetName("grants", used)).toBe("grants-2");
    expect(sanitizeSheetName("GRANTS", used)).toBe("GRANTS-3");
  });

  it("keeps the suffixed name within the 31-char limit and sanitizes illegal characters", () => {
    const used = new Set<string>(),
      long = "A".repeat(31);
    expect(sanitizeSheetName(long, used)).toBe(long);
    const second = sanitizeSheetName(long, used);
    expect(second.length).toBeLessThanOrEqual(31);
    expect(second.endsWith("-2")).toBe(true);
    expect(used.has(second)).toBe(true);
    expect(sanitizeSheetName("Quarter/1?", new Set())).toBe("Quarter 1");
  });

  it("falls back to Sheet for an empty title", () => {
    const used = new Set<string>();
    expect(sanitizeSheetName("", used)).toBe("Sheet");
    expect(sanitizeSheetName("  ", used)).toBe("Sheet-2");
  });
});
