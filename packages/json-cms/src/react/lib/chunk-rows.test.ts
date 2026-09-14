import { describe, expect, it } from "vitest";

import type { ImportRow } from "./chunk-rows.js";
import { chunkRowsForImport } from "./chunk-rows.js";

describe("chunkRowsForImport", () => {
  it("returns a single chunk when everything fits under both caps", () => {
    const rows: ImportRow[] = Array.from({ length: 10 }, (_, i) => ({ data: { n: i } })),
      chunks = chunkRowsForImport(rows);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(10);
  });

  it("splits by row count once maxRows is reached", () => {
    const rows: ImportRow[] = Array.from({ length: 1200 }, (_, i) => ({ data: { n: i } })),
      chunks = chunkRowsForImport(rows, { maxRows: 500 });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toStrictEqual([500, 500, 200]);
    // Every row lands in exactly one chunk, in order.
    expect(chunks.flat()).toStrictEqual(rows);
  });

  it("splits early by byte size even when well under the row-count cap", () => {
    const bigString = "x".repeat(1000),
      rows: ImportRow[] = Array.from({ length: 50 }, (_, i) => ({ data: { i, s: bigString } })),
      chunks = chunkRowsForImport(rows, { maxBytes: 10_000, maxRows: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const bytes = new TextEncoder().encode(JSON.stringify(chunk)).length;
      // A touch of slack: the cap is enforced per-row-add, so a chunk can
      // exceed it by at most the size of the one row that tipped it over.
      expect(bytes).toBeLessThan(10_000 + 1200);
    }
    expect(chunks.flat()).toStrictEqual(rows);
  });

  it("never drops a row even if a single row alone exceeds maxBytes", () => {
    const hugeRow: ImportRow = { data: { s: "x".repeat(20_000) } },
      rows: ImportRow[] = [{ data: { n: 1 } }, hugeRow, { data: { n: 2 } }],
      chunks = chunkRowsForImport(rows, { maxBytes: 5_000 });
    expect(chunks.flat()).toHaveLength(3);
    expect(chunks.flat()).toStrictEqual(rows);
  });

  it("returns no chunks for an empty input", () => {
    expect(chunkRowsForImport([])).toStrictEqual([]);
  });
});
