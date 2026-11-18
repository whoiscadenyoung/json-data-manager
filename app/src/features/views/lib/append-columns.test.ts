import type { Step } from "@caden/data-core/views";
import { describe, expect, test } from "vitest";

import {
  appendMembers,
  deriveColumns,
  mapCell,
  outputFields,
  renameColumn,
  suggestMerges,
  toggleExclude,
} from "./append-columns";

type AppendStep = Extract<Step, { kind: "append" }>;

const FIELDS: Record<string, string[]> = {
  fy23: ["name", "Amount", "only23"],
  fy24: ["name", "amount"],
};

function members(step: AppendStep) {
  return appendMembers(
    step,
    "FY22",
    ["name", "amount"],
    (alias) => FIELDS[alias],
    (alias) => alias.toUpperCase(),
  );
}

const step: AppendStep = {
  kind: "append",
  sources: [{ input: "fy23" }, { input: "fy24" }],
};

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

describe("deriveColumns", () => {
  test("flags merged and partial columns", () => {
    const rows = deriveColumns(members(step));
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(must(byName.get("name")).status).toBe("merged");
    expect(must(byName.get("only23")).status).toBe("partial");
    expect(must(byName.get("only23")).presentIn).toEqual(["FY23"]);
    expect(must(byName.get("Amount")).presentIn).toEqual(["FY23"]);
  });

  test("suggests, and applies, a case-insensitive merge", () => {
    const rows = deriveColumns(members(step));
    const [merge] = suggestMerges(rows);
    expect(merge).toEqual({ into: "amount", from: "Amount" });
    const row = rows.find((candidate) => candidate.name === "Amount");
    const next = renameColumn(step, members(step), must(row), "amount");
    expect(next.sources[0].columns).toEqual([{ from: "Amount", as: "amount" }]);
    const merged = deriveColumns(members(next)).find((r) => r.name === "amount");
    expect(must(merged).status).toBe("merged");
  });
});

describe("edits", () => {
  test("exclude toggles and drops the column from the output", () => {
    const excluded = toggleExclude(step, 1, [], "only23");
    expect(excluded.sources[0].columns).toEqual([{ from: "only23", exclude: true }]);
    expect(outputFields(members(excluded))).not.toContain("only23");
    const restored = toggleExclude(excluded, 1, excluded.sources[0].columns ?? [], "only23");
    expect(restored.sources[0].columns).toBeUndefined();
  });

  test("renaming every feeder of a column renames the output", () => {
    const rows = deriveColumns(members(step));
    const row = rows.find((candidate) => candidate.name === "name");
    const next = renameColumn(step, members(step), must(row), "title");
    expect(next.baseColumns).toEqual([{ from: "name", as: "title" }]);
    expect(outputFields(members(next))).toContain("title");
  });

  test("mapCell re-maps a field and drops a same-named field", () => {
    const m = members(step);
    const next = mapCell(step, m[1], 1, "amount", "Amount");
    expect(next.sources[0].columns).toEqual([{ from: "Amount", as: "amount" }]);
    const clear = mapCell(step, m[0], 0, "amount", undefined);
    expect(clear.baseColumns).toEqual([{ from: "amount", exclude: true }]);
  });
});
