import { describe, expect, it } from "vitest";

import { editedNames, missingFromOnly, toggleOnly } from "./columns-only";

describe("columns only list", () => {
  it("applies renames and drops to the field names", () => {
    expect(
      editedNames(
        ["a", "b", "c"],
        [
          { from: "a", as: "x" },
          { from: "b", exclude: true },
        ],
      ),
    ).toEqual(["x", "c"]);
  });

  it("toggles on with every column and off to undefined", () => {
    expect(toggleOnly(undefined, ["x", "c"])).toEqual(["x", "c"]);
    expect(toggleOnly(["x"], ["x", "c"])).toBeUndefined();
  });

  it("lists the columns not kept yet", () => {
    expect(missingFromOnly(["a"], ["a", "b"])).toEqual(["b"]);
  });
});
