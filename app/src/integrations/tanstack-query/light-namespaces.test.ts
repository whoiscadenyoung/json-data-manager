import { describe, expect, it } from "vitest";

import { isPersistableQueryHash, isPersistableQueryName } from "./light-namespaces";

describe("isPersistableQueryName", () => {
  it("matches the pg store namespaces exactly and with suffixes", () => {
    expect(isPersistableQueryName("datasets")).toBe(true);
    expect(isPersistableQueryName("entries")).toBe(true);
    expect(isPersistableQueryName("geometries")).toBe(false);
    expect(isPersistableQueryName("profiles")).toBe(false);
    // Only the store namespaces persist.
    expect(isPersistableQueryName("cms/schemas")).toBe(false);
    expect(isPersistableQueryName("cms/entries")).toBe(false);
  });
});

describe("isPersistableQueryHash", () => {
  it("persists light pg namespaces (the store modules' key shape)", () => {
    expect(isPersistableQueryHash('["datasets","listSummaries",{}]')).toBe(true);
    // The entries table streams server-side pages — each page query must
    // stay persistable so the table still renders from light state on a
    // cold start.
    expect(isPersistableQueryHash('["entries","listPage",{"datasetId":"abc"}]')).toBe(true);
    expect(isPersistableQueryHash('["maps","list",{"limit":500}]')).toBe(true);
  });

  it("never persists geometry-page or non-light namespaces", () => {
    expect(isPersistableQueryHash('["geometries","rowsForTiles",{}]')).toBe(false);
    expect(isPersistableQueryHash('["imports","get",{}]')).toBe(false);
    expect(isPersistableQueryHash('["profiles","get",{"profileId":"x"}]')).toBe(false);
  });

  it("never persists non-JSON or non-array hashes", () => {
    expect(isPersistableQueryHash("someOtherQuery")).toBe(false);
    expect(isPersistableQueryHash('"entries"')).toBe(false);
    expect(isPersistableQueryHash("[]")).toBe(false);
  });

  it("never restores hashes outside the store namespaces", () => {
    expect(isPersistableQueryHash("legacy|cms/schemas:list|{}")).toBe(false);
    expect(isPersistableQueryHash('legacy|cms/entries:listPage|{"datasetId":"abc"}')).toBe(false);
  });
});
