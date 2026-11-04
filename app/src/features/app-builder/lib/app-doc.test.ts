import { describe, expect, it } from "vitest";

import type { AppRow } from "#/lib/store/apps";

import { appDocOf, canEditApp } from "./app-doc";

/** A minimal store row (migration 0014's DDL) with only the mapped fields varied per test. */
function rowOf(overrides: Partial<AppRow> = {}): AppRow {
  return {
    createdAt: "2026-11-04T00:00:00.000Z",
    createdBy: "11111111-1111-4111-8111-111111111111",
    datasetIds: [],
    description: null,
    example: false,
    id: "aaaaaaa1-0000-4000-8000-000000000001",
    // The 0014 default: an empty pages array (read as one empty first page).
    ownerName: null,
    pages: [],
    revision: 7,
    sharing: "private",
    title: "Parks",
    updatedAt: "2026-11-04T01:00:00.000Z",
    ...overrides,
  };
}

describe("canEditApp", () => {
  const creator = "11111111-1111-4111-8111-111111111111";

  it("edits for the creator", () => {
    expect(canEditApp({ createdBy: creator, example: false }, creator)).toBe(true);
  });

  it("refuses everyone else", () => {
    expect(
      canEditApp({ createdBy: creator, example: false }, "22222222-2222-4222-8222-222222222222"),
    ).toBe(false);
  });

  it("refuses a signed-out viewer", () => {
    expect(canEditApp({ createdBy: creator, example: false }, undefined)).toBe(false);
    expect(canEditApp({ createdBy: creator, example: false }, null)).toBe(false);
  });

  it("refuses the example flag even for its owner — nobody edits a seeded example", () => {
    expect(canEditApp({ createdBy: creator, example: true }, creator)).toBe(false);
  });
});

describe("appDocOf", () => {
  const viewer = "11111111-1111-4111-8111-111111111111";

  it("maps the store row's identity and metadata fields", () => {
    const doc = appDocOf(rowOf({ description: "hello", sharing: "link" }), viewer);
    expect(doc.id).toBe("aaaaaaa1-0000-4000-8000-000000000001");
    expect(doc.title).toBe("Parks");
    expect(doc.description).toBe("hello");
    expect(doc.sharing).toBe("link");
    expect(doc.revision).toBe(7);
    expect(doc.updatedAt).toBe("2026-11-04T01:00:00.000Z");
    expect(doc.example).toBe(false);
    expect(doc.canEdit).toBe(true);
  });

  it("normalizes a null pages column to one empty first page", () => {
    const doc = appDocOf(rowOf(), viewer);
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].id).toBe("page-1");
  });

  it("normalizes an empty pages array the same way", () => {
    const doc = appDocOf(rowOf({ pages: [] }), viewer);
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].id).toBe("page-1");
  });

  it("carries stored pages through untouched", () => {
    const pages = [{ id: "p2", layout: "fullscreen" as const, title: "Map", widgets: [] }];
    const doc = appDocOf(rowOf({ pages }), viewer);
    expect(doc.pages).toBe(pages);
  });

  it("marks a seeded example read-only even for the viewing creator", () => {
    const doc = appDocOf(rowOf({ example: true }), viewer);
    expect(doc.example).toBe(true);
    expect(doc.canEdit).toBe(false);
  });

  it("carries the app's dataset references in order", () => {
    const datasetIds = ["d1", "d2"];
    expect(appDocOf(rowOf({ datasetIds }), viewer).datasetIds).toStrictEqual(datasetIds);
  });
});
