import { describe, expect, test } from "vitest";

import { suggestKeys } from "./link-suggestions";

describe("suggestKeys", () => {
  test("matches shared names, exact first, ignoring case and punctuation", () => {
    expect(suggestKeys(["fiscal_year", "UEI", "name"], ["uei", "Fiscal Year", "name"])).toEqual([
      { fromKey: "name", toKey: "name" },
      { fromKey: "fiscal_year", toKey: "Fiscal Year" },
      { fromKey: "UEI", toKey: "uei" },
    ]);
  });
  test("row-id columns come last", () => {
    expect(suggestKeys(["OBJECTID", "UEI"], ["OBJECTID", "UEI"])[0]).toEqual({
      fromKey: "UEI",
      toKey: "UEI",
    });
  });
  test("nothing shared gives no suggestions", () => {
    expect(suggestKeys(["a"], ["b"])).toEqual([]);
  });
});
