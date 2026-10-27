import { describe, expect, it } from "vitest";

import { isPersistableQueryHash, isPersistableQueryName } from "./light-namespaces";

describe("isPersistableQueryName", () => {
  it("matches the namespace exactly and with function suffixes", () => {
    expect(isPersistableQueryName("cms/schemas")).toBe(true);
    expect(isPersistableQueryName("cms/schemas:list")).toBe(true);
    expect(isPersistableQueryName("cms/geometries")).toBe(false);
    expect(isPersistableQueryName("cms/schemasProxy:list")).toBe(false);
    // The pre-B3 top-level names no longer exist.
    expect(isPersistableQueryName("schemas:list")).toBe(false);
  });
});

describe("isPersistableQueryHash", () => {
  it("persists light Convex namespaces", () => {
    expect(isPersistableQueryHash("convexQuery|cms/schemas:list|{}")).toBe(true);
    expect(isPersistableQueryHash('convexQuery|cms/entries:list|{"schemaId":"abc"}')).toBe(true);
    // Issue #54: the entries table streams server-side pages now — each
    // `entries.listPage` page (one query per cursor) must stay persistable so
    // the table still renders from light state on a cold start.
    expect(
      isPersistableQueryHash(
        'convexQuery|cms/entries:listPage|{"schemaId":"abc","paginationOpts":{"numItems":200,"cursor":null}}',
      ),
    ).toBe(true);
    expect(isPersistableQueryHash('convexQuery|cms/tile_archives:metas|{"schemaIds":[]}')).toBe(
      true,
    );
  });

  it("never persists geometry-page or non-light namespaces", () => {
    expect(isPersistableQueryHash("convexQuery|cms/geometries:list|{}")).toBe(false);
    expect(isPersistableQueryHash("convexQuery|cms/imports:status|{}")).toBe(false);
  });

  it("never persists non-Convex queries", () => {
    expect(isPersistableQueryHash("someOtherQuery")).toBe(false);
  });

  it("requires the full hash shape (no bare names)", () => {
    expect(isPersistableQueryHash("cms/schemas:list")).toBe(false);
  });
});
