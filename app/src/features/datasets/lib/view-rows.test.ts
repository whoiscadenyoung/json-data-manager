import { describe, expect, it } from "vitest";

import { VIEW_ROWS_HINT, viewRowsReadOnlyReason } from "./view-rows";

describe("viewRowsReadOnlyReason", () => {
  it("makes a view's rows read-only with a reason that points at the view editor", () => {
    expect(viewRowsReadOnlyReason({ kind: "view" })).toBe(VIEW_ROWS_HINT);
    expect(VIEW_ROWS_HINT).toMatch(/view editor/);
  });

  it("leaves source datasets editable", () => {
    expect(viewRowsReadOnlyReason({ kind: "source" })).toBeUndefined();
  });
});
