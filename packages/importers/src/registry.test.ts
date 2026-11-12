import { describe, expect, it } from "vitest";

import { enabledAcceptString, enabledExtensionsHint, findImportParser } from "./registry.js";

function fileNamed(name: string, type = ""): File {
  return new File(["x"], name, { type });
}

describe("import parser registry", () => {
  it("dispatches by extension to the right parser", () => {
    const jsonParser = findImportParser(fileNamed("data.json")),
      csvParser = findImportParser(fileNamed("data.csv")),
      xlsxParser = findImportParser(fileNamed("data.xlsx")),
      xlsParser = findImportParser(fileNamed("data.xls"));
    expect(jsonParser === undefined ? undefined : jsonParser.id).toBe("json");
    expect(csvParser === undefined ? undefined : csvParser.id).toBe("csv");
    expect(xlsxParser === undefined ? undefined : xlsxParser.id).toBe("xlsx");
    expect(xlsParser === undefined ? undefined : xlsParser.id).toBe("xls");
  });

  it("does not let the legacy .xls parser claim .xlsx files", () => {
    const parser = findImportParser(fileNamed("data.xlsx"));
    expect(parser === undefined ? undefined : parser.id).not.toBe("xls");
  });

  it("dispatches a .geojson file to the JSON parser", () => {
    const parser = findImportParser(fileNamed("smart_awards.geojson"));
    expect(parser === undefined ? undefined : parser.id).toBe("json");
  });

  it("returns undefined for an unrecognized extension", () => {
    expect(findImportParser(fileNamed("data.txt"))).toBeUndefined();
  });

  it("exposes every enabled parser's accept string and extensions", () => {
    expect(enabledAcceptString()).toContain(".csv");
    expect(enabledAcceptString()).toContain(".xlsx");
    expect(enabledAcceptString()).toContain(".xls");
    expect(enabledAcceptString()).toContain(".geojson");
    expect(enabledExtensionsHint()).toBe(
      ".json, .jsonl, .ndjson, .geojson, .csv, .xlsx, .xlsm, .xls",
    );
  });
});
