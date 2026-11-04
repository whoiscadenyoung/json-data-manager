import { describe, expect, it, vi } from "vitest";

// The lib's import chain reaches `#/env` through the integrations client
// (which validates at import time); CI has no .env.local — the
// stage-3-ci-tree-lessons mock, applied before any lib import.
vi.mock("#/env", () => ({
  env: { VITE_SUPABASE_ANON_KEY: "test-anon-key", VITE_SUPABASE_URL: "http://127.0.0.1:54321" },
}));

import { stubSupabase } from "#/lib/store/test-support";
import { VERSION_DIFF_LIMIT } from "#/lib/store/versions";

import {
  headVersionOf,
  nextVersionLabelOf,
  overlayRowsQueryOptions,
  priorVersionOf,
} from "./pg-versioning";

/** One chain row for the selection helpers (the fields they read). */
function versionOf(
  id: string,
  versionLabel: string,
  ref = `ref-${id}`,
): {
  id: string;
  ref: string;
  versionLabel: string;
} {
  return { id, ref, versionLabel };
}

/** The bounded read's queryFn, invoked the way the test-support seam does (the store queryFns never read TanStack's context). */
async function runOverlayRead(
  versionId: string,
  client: ReturnType<typeof stubSupabase>["client"],
): Promise<{ rows: Array<{ data: Record<string, unknown>; key: string }>; truncated: boolean }> {
  const options = overlayRowsQueryOptions({ versionId }, { supabase: client });
  const queryFn = options.queryFn;
  if (queryFn === undefined) {
    throw new Error("The overlay read carries no queryFn.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the read never touches the v5 context (the test-support seam's rule).
  return await queryFn({} as never);
}

describe("priorVersionOf", () => {
  const chain = [versionOf("v3", "v3"), versionOf("v2", "v2"), versionOf("v1", "v1")];
  it("returns the version one step OLDER than the pinned one", () => {
    expect(priorVersionOf(chain, "v2")).toEqual({
      id: "v1",
      ref: "ref-v1",
      versionLabel: "v1",
    });
    expect(priorVersionOf(chain, "v3")).toEqual({
      id: "v2",
      ref: "ref-v2",
      versionLabel: "v2",
    });
  });
  it("answers undefined at the first version — nothing older to revert to", () => {
    expect(priorVersionOf(chain, "v1")).toBeUndefined();
  });
  it("answers undefined for a pin the chain doesn't know", () => {
    expect(priorVersionOf(chain, "vX")).toBeUndefined();
  });
});

describe("headVersionOf and nextVersionLabelOf", () => {
  it("reads the head from the newest-first chain", () => {
    const head = headVersionOf([versionOf("v2", "v2"), versionOf("v1", "v1")]);
    expect(head !== undefined ? head.id : "").toBe("v2");
    expect(headVersionOf([])).toBeUndefined();
  });
  it("suggests v1 for an empty chain and a non-vN head", () => {
    expect(nextVersionLabelOf([])).toBe("v1");
    expect(nextVersionLabelOf([versionOf("vX", "release-1")])).toBe("v1");
  });
  it("increments a vN head", () => {
    expect(nextVersionLabelOf([versionOf("v7", "v7")])).toBe("v8");
  });
});

describe("overlayRowsQueryOptions", () => {
  it("reads the bounded position window with the exact truncation flag (at-limit is NOT truncated, #126)", async () => {
    const stub = stubSupabase((query) => {
      if (query.table === "version_entries") {
        const limitOp = query.operations.find((op) => op.method === "limit");
        const limit = limitOp === undefined ? 0 : Number(limitOp.args[0]);
        const rows = Array.from({ length: limit - 1 }, (_, index) => ({
          data: { label: `row-${index}` },
          entryId: `e-${index}`,
        }));
        return { data: rows };
      }
      return { data: null };
    });
    const { rows, truncated } = await runOverlayRead("version-1", stub.client);
    expect(truncated).toBe(false);
    expect(rows).toHaveLength(VERSION_DIFF_LIMIT);
    expect(rows[0] !== undefined ? rows[0].key : "").toBe("row-0");
  });

  it("flags one row past the budget as truncated and trims to the limit", async () => {
    const stub = stubSupabase((query) => {
      if (query.table === "version_entries") {
        const limitOp = query.operations.find((op) => op.method === "limit");
        const limit = limitOp === undefined ? 0 : Number(limitOp.args[0]);
        const rows = Array.from({ length: limit }, (_, index) => ({
          data: { label: `row-${index}` },
          entryId: `e-${index}`,
        }));
        return { data: rows };
      }
      return { data: null };
    });
    const { rows, truncated } = await runOverlayRead("version-1", stub.client);
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(VERSION_DIFF_LIMIT);
  });

  it("keys rows by the ONE key rule and skips provenance-severed and non-record rows", async () => {
    const stub = stubSupabase((query) => {
      if (query.table === "version_entries") {
        return {
          data: [
            { data: { label: "Labeled" }, entryId: "e-1" },
            { data: { name: "Named" }, entryId: "e-2" },
            { data: { other: 1 }, entryId: "e-3" },
            { data: { label: "orphan" }, entryId: null },
            { data: [1, 2, 3], entryId: "e-4" },
          ],
        };
      }
      return { data: null };
    });
    const { rows, truncated } = await runOverlayRead("version-1", stub.client);
    expect(rows.map((row) => row.key)).toEqual(["Labeled", "Named", "e-3"]);
    expect(truncated).toBe(false);
  });
});
