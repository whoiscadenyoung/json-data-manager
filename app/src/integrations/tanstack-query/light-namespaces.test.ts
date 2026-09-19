import { describe, expect, it } from "vitest";

import { isPersistableQueryHash, isPersistableQueryName } from "./light-namespaces";

describe("isPersistableQueryName", () => {
  it("matches the namespace exactly and with function suffixes", () => {
    expect(isPersistableQueryName("schemas")).toBe(true);
    expect(isPersistableQueryName("schemas:list")).toBe(true);
    expect(isPersistableQueryName("geometries")).toBe(false);
    expect(isPersistableQueryName("schemasProxy:list")).toBe(false);
  });
});

describe("isPersistableQueryHash", () => {
  it("persists light Convex namespaces", () => {
    expect(isPersistableQueryHash("convexQuery|schemas:list|{}")).toBe(true);
    expect(isPersistableQueryHash("convexQuery|entries:list|{\"schemaId\":\"abc\"}")).toBe(true);
    // Issue #54: the entries table streams server-side pages now — each
    // `entries.listPage` page (one query per cursor) must stay persistable so
    // the table still renders from light state on a cold start.
    expect(
      isPersistableQueryHash(
        'convexQuery|entries:listPage|{"schemaId":"abc","paginationOpts":{"numItems":200,"cursor":null}}',
      ),
    ).toBe(true);
    expect(isPersistableQueryHash("convexQuery|tile_archives:metas|{\"schemaIds\":[]}")).toBe(true);
  });

  it("never persists geometry-page or non-light namespaces", () => {
    expect(isPersistableQueryHash("convexQuery|geometries:list|{}")).toBe(false);
    expect(isPersistableQueryHash("convexQuery|imports:status|{}")).toBe(false);
  });

  it("never persists non-Convex queries", () => {
    expect(isPersistableQueryHash("someOtherQuery")).toBe(false);
  });

  it("requires the full hash shape (no bare names)", () => {
    expect(isPersistableQueryHash("schemas:list")).toBe(false);
  });
});
