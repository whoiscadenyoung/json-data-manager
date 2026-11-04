import { describe, expect, it } from "vitest";

import { isPersistableQueryHash, isPersistableQueryName } from "./light-namespaces";

describe("isPersistableQueryName", () => {
  it("matches the pg store namespaces exactly and with suffixes", () => {
    expect(isPersistableQueryName("pg:datasets")).toBe(true);
    expect(isPersistableQueryName("pg:entries")).toBe(true);
    expect(isPersistableQueryName("pg:geometries")).toBe(false);
    expect(isPersistableQueryName("pg:profiles")).toBe(false);
    // The convex namespaces left with the stage-7 disconnect (issue #206).
    expect(isPersistableQueryName("cms/schemas")).toBe(false);
    expect(isPersistableQueryName("cms/entries")).toBe(false);
  });
});

describe("isPersistableQueryHash", () => {
  it("persists light pg namespaces (the store modules' key shape)", () => {
    expect(isPersistableQueryHash('["pg:datasets","listSummaries",{}]')).toBe(true);
    // The entries table streams server-side pages — each page query must
    // stay persistable so the table still renders from light state on a
    // cold start.
    expect(isPersistableQueryHash('["pg:entries","listPage",{"datasetId":"abc"}]')).toBe(true);
    expect(isPersistableQueryHash('["pg:maps","list",{"limit":500}]')).toBe(true);
  });

  it("never persists geometry-page or non-light namespaces", () => {
    expect(isPersistableQueryHash('["pg:geometries","rowsForTiles",{}]')).toBe(false);
    expect(isPersistableQueryHash('["pg:imports","get",{}]')).toBe(false);
    expect(isPersistableQueryHash('["pg:profiles","get",{"profileId":"x"}]')).toBe(false);
  });

  it("never persists non-JSON or non-array hashes", () => {
    expect(isPersistableQueryHash("someOtherQuery")).toBe(false);
    expect(isPersistableQueryHash('"pg:entries"')).toBe(false);
    expect(isPersistableQueryHash("[]")).toBe(false);
  });

  it("never restores the convex-era hashes (v2 cache is discarded by the v3 key bump)", () => {
    expect(isPersistableQueryHash("convexQuery|cms/schemas:list|{}")).toBe(false);
    expect(isPersistableQueryHash('convexQuery|cms/entries:listPage|{"schemaId":"abc"}')).toBe(
      false,
    );
  });
});
