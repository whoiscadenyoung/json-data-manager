import { describe, expect, it } from "vitest";

import { jsonParser } from "./json-parser.js";

function fileNamed(name: string, type = ""): File {
  return new File(["x"], name, { type });
}

describe("jsonParser.matches", () => {
  it("matches .json, .jsonl, and .ndjson files by extension", () => {
    expect(jsonParser.matches(fileNamed("data.json"))).toBe(true);
    expect(jsonParser.matches(fileNamed("data.jsonl"))).toBe(true);
    expect(jsonParser.matches(fileNamed("data.ndjson"))).toBe(true);
  });

  it("matches a .geojson file by extension, even with no MIME type", () => {
    // Real-world .geojson uploads: many OSes report an empty file.type for
    // this extension, so the extension check has to carry the match on its own.
    expect(jsonParser.matches(fileNamed("smart_awards.geojson", ""))).toBe(true);
    expect(jsonParser.matches(fileNamed("SMART_AWARDS.GEOJSON", ""))).toBe(true);
  });

  it("matches a .geojson file by its GeoJSON MIME types too", () => {
    expect(jsonParser.matches(fileNamed("data.geojson", "application/geo+json"))).toBe(true);
    expect(jsonParser.matches(fileNamed("data.geojson", "application/vnd.geo+json"))).toBe(true);
  });

  it("does not match unrelated extensions", () => {
    expect(jsonParser.matches(fileNamed("data.csv"))).toBe(false);
    expect(jsonParser.matches(fileNamed("data.xlsx"))).toBe(false);
  });
});

describe("jsonParser.extensions and accept", () => {
  it("lists .geojson alongside .json, .jsonl, and .ndjson", () => {
    expect(jsonParser.extensions).toStrictEqual([".json", ".jsonl", ".ndjson", ".geojson"]);
  });

  it("includes .geojson and its MIME types in the accept string", () => {
    expect(jsonParser.accept).toContain(".geojson");
    expect(jsonParser.accept).toContain("application/geo+json");
    expect(jsonParser.accept).toContain("application/vnd.geo+json");
  });
});
