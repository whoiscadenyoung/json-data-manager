import { describe, expect, it } from "vitest";

import type { TransformSpec } from "./spec.js";

const chainedSpec: TransformSpec = {
  sourceDatasetId: "restaurantLocations",
  operations: [
    {
      kind: "lookup",
      lookupDatasetId: "grants",
      baseKey: "grantId",
      lookupKey: "grantId",
      fields: ["status"],
      namespace: "grants",
      match: "left",
      onDuplicateKey: "first",
    },
    {
      kind: "lookup",
      lookupDatasetId: "orgs",
      baseKey: "orgId",
      lookupKey: "orgId",
    },
  ],
};

describe("TransformSpec", () => {
  it("survives a JSON round-trip byte-for-byte — specs are stored serializable data", () => {
    expect(JSON.parse(JSON.stringify(chainedSpec))).toStrictEqual(chainedSpec);
  });

  it("exposes its dependencies by walking operations — the walk stage 2's cycle rejection needs", () => {
    const dependencies: string[] = [];
    for (const operation of chainedSpec.operations) {
      if (operation.kind === "lookup") {
        dependencies.push(operation.lookupDatasetId);
      }
    }
    expect(dependencies).toStrictEqual(["grants", "orgs"]);
    expect(dependencies).not.toContain(chainedSpec.sourceDatasetId);
  });

  it("carries the policy defaults as plain (absent) fields, not behavior hidden in code a spec cannot express", () => {
    const minimal: TransformSpec = {
      sourceDatasetId: "locations",
      operations: [
        { kind: "lookup", lookupDatasetId: "grants", baseKey: "grantId", lookupKey: "grantId" },
      ],
    };
    expect(JSON.parse(JSON.stringify(minimal))).toStrictEqual(minimal);
  });
});
