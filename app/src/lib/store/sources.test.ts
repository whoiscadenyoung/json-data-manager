// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// The store's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any store import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import {
  chunkByJsonBytes,
  getSource,
  registerSource,
  registeredSources,
  unregisterSource,
  type ClientSource,
  type ProjectionRow,
} from "./sources";

/** A minimal client-read source (the stand-in shape the tests and a rebuilt demo would register). */
function standInSource(key: string, rows: ProjectionRow[]): ClientSource {
  return {
    dataset: {
      description: "Stand-in source",
      geometryType: "Point",
      kind: "geospatial",
      schema: { type: "object" },
      title: `Stand-in ${key}`,
    },
    key,
    listRows: async () => ({ cursor: null, rows }),
    mapping: {
      entryKey: "row.id",
      fields: { label: "label" },
      geometry: { kind: "latLng", lat: "lat", lng: "lng" },
    },
    transport: "client",
  };
}

/** The element at the index, or a loud failure (the no-optional-chaining test style). */
function at<T>(items: ReadonlyArray<T>, index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Expected an item at index ${index} (have ${items.length}).`);
  }
  return item;
}

describe("sources registry", () => {
  it("ships the two deployment layers and answers them by key", () => {
    const keys = registeredSources().map((source) => source.key);
    expect(keys).toContain("deployments.centroids");
    expect(keys).toContain("deployments.routes");
    expect(getSource("deployments.centroids").transport).toBe("http");
  });

  it("throws on an unknown source key (the registry's fail-loud rule)", () => {
    expect(() => {
      getSource("no.such.source");
    }).toThrow(/Unknown bound source/);
  });

  it("registers and unregisters stand-in sources", () => {
    const standIn = standInSource("test.stand-in", []);
    registerSource(standIn);
    expect(getSource("test.stand-in").key).toBe("test.stand-in");
    unregisterSource("test.stand-in");
    expect(() => {
      getSource("test.stand-in");
    }).toThrow(/Unknown bound source/);
  });
});

describe("chunkByJsonBytes (the collect leg's chunking, registry.ts parity)", () => {
  it("keeps small rows on one chunk", () => {
    const chunks = chunkByJsonBytes([{ key: "a" }, { key: "b" }]);
    expect(chunks.length).toBe(1);
    expect(at(chunks, 0).length).toBe(2);
  });

  it("splits at the row limit so one chunk's rows fit a request body", () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({ key: `k${index}` }));
    const chunks = chunkByJsonBytes(rows);
    expect(chunks.length).toBe(3);
    expect(at(chunks, 0).length).toBe(500);
    expect(at(chunks, 1).length).toBe(500);
    expect(at(chunks, 2).length).toBe(200);
  });

  it("splits before the byte limit would blow a chunk", () => {
    const big = { key: "k", data: "x".repeat(400_000) };
    const chunks = chunkByJsonBytes([big, big, big]);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(1);
    }
  });

  it("never emits an empty chunk (a lone oversized row still lands)", () => {
    const huge = { key: "k", data: "x".repeat(1_000_000) };
    const chunks = chunkByJsonBytes([huge]);
    expect(chunks.length).toBe(1);
  });
});
