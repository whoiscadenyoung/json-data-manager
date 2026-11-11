import { describe, expect, test } from "vitest";

import {
  arcGisProblem,
  moveRow,
  outputFieldsOf,
  outputRowsOf,
  patchRow,
  renameNote,
  rowProblems,
  setKept,
} from "./output-model";

const FIELDS = ["name", "deployments", "docsLink"];

describe("output model", () => {
  test("an empty output keeps every field as named", () => {
    const rows = outputRowsOf({ fields: [], emptyFields: "keep" }, FIELDS);
    expect(rows.map((r) => r.key)).toEqual(FIELDS);
    expect(outputFieldsOf(rows, FIELDS)).toEqual([]);
  });

  test("a rename keeps the original in `from`", () => {
    const rows = patchRow(outputRowsOf({ fields: [], emptyFields: "keep" }, FIELDS), 1, {
      key: "deploys",
      label: "Deploys",
    });
    expect(outputFieldsOf(rows, FIELDS)).toEqual([
      { key: "name" },
      { key: "deploys", from: "deployments", label: "Deploys" },
      { key: "docsLink" },
    ]);
    const row = rows[1];
    expect(row === undefined ? "" : renameNote(row)).toBe("deployments → deploys");
  });

  test("round trips labels, hidden flags and left-out fields", () => {
    const fields = [
      { key: "docsLink", hidden: true },
      { key: "name", label: "State" },
    ];
    const rows = outputRowsOf({ fields, emptyFields: "omit" }, FIELDS);
    expect(rows.map((r) => [r.key, r.kept])).toEqual([
      ["docsLink", true],
      ["name", true],
      ["deployments", false],
    ]);
    expect(outputFieldsOf(rows, FIELDS)).toEqual(fields);
  });

  test("reordering moves kept rows only", () => {
    const rows = outputRowsOf({ fields: [], emptyFields: "keep" }, FIELDS);
    const moved = moveRow(rows, 0, 1);
    expect(moved.map((r) => r.key)).toEqual(["deployments", "name", "docsLink"]);
    expect(outputFieldsOf(moved, FIELDS).map((f) => f.key)).toEqual([
      "deployments",
      "name",
      "docsLink",
    ]);
    const left = setKept(rows, 2, false);
    expect(moveRow(left, 1, 1).map((r) => r.key)).toEqual(["name", "deployments", "docsLink"]);
  });

  test("ArcGIS names", () => {
    expect(arcGisProblem("good_name1")).toBeUndefined();
    expect(arcGisProblem("1bad")).toMatch(/start with a letter/);
    expect(arcGisProblem("has space")).toMatch(/letters, digits/);
    expect(arcGisProblem("a".repeat(65))).toMatch(/64/);
  });

  test("problems flag duplicates and skip hidden fields", () => {
    let rows = outputRowsOf({ fields: [], emptyFields: "keep" }, FIELDS);
    rows = patchRow(rows, 1, { key: "name" });
    rows = patchRow(rows, 2, { key: "bad key", hidden: true });
    const problems = rowProblems(rows);
    expect(problems[0]).toMatchObject({ duplicate: true });
    expect(problems[1]).toMatchObject({ duplicate: true });
    expect(problems[2]).toMatchObject({ arcgis: undefined });
  });
});
