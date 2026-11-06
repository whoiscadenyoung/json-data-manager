import { describe, expect, it } from "vitest";

import type { AppRow } from "#/lib/store/apps";

import { appDocOf, canEditApp } from "./app-doc";

/** A minimal store row (migration 0022's DDL) with only the mapped fields varied per test. */
function rowOf(overrides: Partial<AppRow> = {}): AppRow {
  return {
    createdAt: "2026-11-04T00:00:00.000Z",
    createdBy: "11111111-1111-4111-8111-111111111111",
    datasetIds: [],
    description: null,
    example: false,
    id: "aaaaaaa1-0000-4000-8000-000000000001",
    pages: [],
    project: {
      createdBy: "11111111-1111-4111-8111-111111111111",
      id: "p1",
      title: "Parks project",
    },
    projectId: "p1",
    // The 0014 default: an empty pages array (read as one empty first page).
    revision: 7,
    sharing: "private",
    title: "Parks",
    updatedAt: "2026-11-04T01:00:00.000Z",
    ...overrides,
  };
}

describe("canEditApp", () => {
  it("edits for the project's owner seat", () => {
    expect(canEditApp({ example: false }, "owner")).toBe(true);
  });

  it("edits for the project's editor seat — the 0014 creator gate is now project roles", () => {
    expect(canEditApp({ example: false }, "editor")).toBe(true);
  });

  it("refuses a viewer seat", () => {
    expect(canEditApp({ example: false }, "viewer")).toBe(false);
  });

  it("refuses a signed-out viewer (no membership resolved)", () => {
    expect(canEditApp({ example: false }, undefined)).toBe(false);
    expect(canEditApp({ example: false }, null)).toBe(false);
  });

  it("refuses the example flag even for its project's owner — nobody edits a seeded example", () => {
    expect(canEditApp({ example: true }, "owner")).toBe(false);
  });
});

describe("appDocOf", () => {
  it("maps the store row's identity and metadata fields", () => {
    const doc = appDocOf(rowOf({ description: "hello", sharing: "link" }), "owner");
    expect(doc.id).toBe("aaaaaaa1-0000-4000-8000-000000000001");
    expect(doc.title).toBe("Parks");
    expect(doc.description).toBe("hello");
    expect(doc.sharing).toBe("link");
    expect(doc.revision).toBe(7);
    expect(doc.updatedAt).toBe("2026-11-04T01:00:00.000Z");
    expect(doc.example).toBe(false);
    expect(doc.projectId).toBe("p1");
    expect(doc.projectTitle).toBe("Parks project");
    expect(doc.canEdit).toBe(true);
  });

  it("normalizes a null pages column to one empty first page", () => {
    const doc = appDocOf(rowOf(), "owner");
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].id).toBe("page-1");
  });

  it("normalizes an empty pages array the same way", () => {
    const doc = appDocOf(rowOf({ pages: [] }), "owner");
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0].id).toBe("page-1");
  });

  it("carries stored pages through untouched", () => {
    const pages = [{ id: "p2", layout: "fullscreen" as const, title: "Map", widgets: [] }];
    const doc = appDocOf(rowOf({ pages }), "owner");
    expect(doc.pages).toBe(pages);
  });

  it("marks a seeded example read-only even for the viewing owner", () => {
    const doc = appDocOf(rowOf({ example: true }), "owner");
    expect(doc.example).toBe(true);
    expect(doc.canEdit).toBe(false);
  });

  it("carries the app's dataset references in order", () => {
    const datasetIds = ["d1", "d2"];
    expect(appDocOf(rowOf({ datasetIds }), "owner").datasetIds).toStrictEqual(datasetIds);
  });

  it("carries a null project embed as a null chip (an example read by a non-member)", () => {
    const doc = appDocOf(rowOf({ project: null }), "viewer");
    expect(doc.projectTitle).toBe(null);
    expect(doc.projectId).toBe("p1");
  });
});
