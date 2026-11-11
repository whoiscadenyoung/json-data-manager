import type { OutputSchema } from "@caden/data-core/views";
import { describe, expect, test } from "vitest";

import {
  buildCsv,
  buildFeatureCollection,
  defaultSettings,
  exportColumns,
  parseSettings,
  roundCoordinates,
  serializeExport,
} from "./export-profile";
import type { ExportRow, ExportSettings } from "./export-profile";

// The design §5 fixture: Kansas has no benefits link, so `benefitsLink` is empty.
const OUTPUT: OutputSchema = {
  emptyFields: "omit",
  fields: [
    { key: "name" },
    { key: "deployments", label: "Deployments" },
    { key: "mostCollaboration", label: "Most collaboration" },
    { key: "docsLink" },
    { key: "benefitsLink" },
    { key: "agencyCount", hidden: true },
  ],
};

const KANSAS: ExportRow = {
  data: {
    name: "Kansas",
    deployments: 14,
    mostCollaboration: "Main Street",
    docsLink: "https://example.test/docs",
    benefitsLink: null,
    agencyCount: 3,
  },
  geometry: { type: "Point", coordinates: [-98.123456789, 38.987654321] },
};

const SETTINGS: ExportSettings = {
  format: "geojson",
  propertyNames: "keys",
  emptyFields: "omit",
  precision: null,
};

function props(settings: ExportSettings, rows: ExportRow[] = [KANSAS]) {
  const columns = exportColumns(OUTPUT, rows, settings.propertyNames);
  const collection = buildFeatureCollection(rows, columns, settings);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test reads the builder's own shape.
  const features = collection["features"] as { properties: Record<string, unknown> }[];
  return features.map((feature) => feature.properties);
}

describe("export profile serializer", () => {
  test("omit empty: Kansas has exactly four properties, hidden agencyCount excluded", () => {
    const [kansas] = props(SETTINGS);
    expect(Object.keys(kansas ?? {})).toEqual([
      "name",
      "deployments",
      "mostCollaboration",
      "docsLink",
    ]);
  });

  test("keep empty: all five keys, with a null", () => {
    const [kansas] = props({ ...SETTINGS, emptyFields: "keep" });
    expect(Object.keys(kansas ?? {})).toEqual([
      "name",
      "deployments",
      "mostCollaboration",
      "docsLink",
      "benefitsLink",
    ]);
    expect(kansas).toMatchObject({ benefitsLink: null });
  });

  test("labels mode uses labels as property names, falling back to keys", () => {
    const [kansas] = props({ ...SETTINGS, propertyNames: "labels" });
    expect(Object.keys(kansas ?? {})).toEqual([
      "name",
      "Deployments",
      "Most collaboration",
      "docsLink",
    ]);
  });

  test("colliding labels fall back to the key", () => {
    const output: OutputSchema = {
      emptyFields: "keep",
      fields: [
        { key: "a", label: "Same" },
        { key: "b", label: "Same" },
      ],
    };
    expect(exportColumns(output, [], "labels").map((c) => c.name)).toEqual(["Same", "b"]);
  });

  test("an empty field list exports every key of the rows", () => {
    const columns = exportColumns({ fields: [], emptyFields: "keep" }, [KANSAS], "keys");
    expect(columns.map((c) => c.name)).toContain("agencyCount");
  });

  test("precision rounds coordinates", () => {
    expect(roundCoordinates([[1.23456, 2.98765]], 2)).toEqual([[1.23, 2.99]]);
    const collection = buildFeatureCollection([KANSAS], exportColumns(OUTPUT, [KANSAS], "keys"), {
      ...SETTINGS,
      precision: 3,
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test reads the builder's own shape.
    const features = collection["features"] as { geometry: { coordinates: number[] } }[];
    expect(features[0]).toMatchObject({ geometry: { coordinates: [-98.123, 38.988] } });
  });

  test("csv quotes cells and drops fully empty columns under omit", () => {
    const rows: ExportRow[] = [{ data: { name: 'A "q", b', deployments: 1 }, geometry: null }];
    const text = buildCsv(rows, exportColumns(OUTPUT, rows, "keys"), SETTINGS);
    expect(text).toBe('name,deployments\n"A ""q"", b",1');
  });

  test("serializeExport picks the extension", () => {
    expect(serializeExport([KANSAS], OUTPUT, { ...SETTINGS, format: "csv" }).extension).toBe("csv");
    expect(serializeExport([KANSAS], OUTPUT, { ...SETTINGS, format: "json" }).extension).toBe(
      "json",
    );
    expect(serializeExport([KANSAS], OUTPUT, SETTINGS).extension).toBe("geojson");
  });

  test("settings default from the view and survive bad input", () => {
    expect(defaultSettings(OUTPUT).emptyFields).toBe("omit");
    expect(parseSettings({ format: "nope", precision: 99 }, OUTPUT)).toEqual({
      format: "geojson",
      propertyNames: "keys",
      emptyFields: "omit",
      precision: null,
    });
  });
});
