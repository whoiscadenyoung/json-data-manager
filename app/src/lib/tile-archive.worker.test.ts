import type { ConvexClient } from "convex/browser";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The tile worker's geometry-fetch pool contract (issue #134): at most
 * {@link GEOMETRY_FETCH_POOL_SIZE} payload fetches are ever in flight —
 * verified here against a mocked global fetch that counts concurrency —
 * across pages, with byte-exact payload accounting.
 */
import { fetchAllGeometryFeatures } from "./tile-archive.worker";

vi.mock("#/env", () => ({ env: { VITE_CONVEX_URL: "http://127.0.0.1:3212" } }));

interface FakeGeometryRow {
  entryId: string;
  geometryJson?: string;
  geometryUrl?: string;
}

const { geometryPages, setGeometryPages } = vi.hoisted(() => {
  let pages: Array<Array<FakeGeometryRow>> = [];
  return {
    geometryPages: (): Array<Array<FakeGeometryRow>> => pages,
    setGeometryPages: (next: Array<Array<FakeGeometryRow>>): void => {
      pages = next;
    },
  };
});

vi.mock("./dataset-rows", () => ({
  forEachDatasetGeometryPage: async (
    _schemaId: string,
    onPage: (rows: Array<FakeGeometryRow>) => void,
  ): Promise<void> => {
    for (const page of geometryPages()) {
      onPage(page);
    }
  },
}));

const GEOMETRY_JSON = JSON.stringify({ type: "Point", coordinates: [1, 2] });

type FakeFetchResponse = { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> };

function stubFetch() {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn<() => Promise<FakeFetchResponse>>(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Hold each fetch a tick so overlapping fetches actually coexist.
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return {
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode(GEOMETRY_JSON).buffer,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, maxInFlight: () => maxInFlight };
}

function urlRow(i: number): FakeGeometryRow {
  return { entryId: `e${i}`, geometryUrl: `https://storage.test/geo/${i}` };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker geometry fetch pool", () => {
  it("never exceeds the pool bound with fetches in flight", async () => {
    // 40 rows over two pages: more rows than the pool size, so the bound is
    // what limits concurrency, and two pages so the bound holds across the
    // sequential page loop too.
    setGeometryPages([
      Array.from({ length: 25 }, (_, i) => urlRow(i)),
      Array.from({ length: 15 }, (_, i) => urlRow(25 + i)),
    ]);
    const { fetchMock, maxInFlight } = stubFetch();

    const { features, payloadBytes } = await fetchAllGeometryFeatures(
      {} as ConvexClient,
      "schema1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(40);
    // The bound is the worker's GEOMETRY_FETCH_POOL_SIZE (12); a serial
    // regression would make this assert vacuous, hence the next line.
    expect(maxInFlight()).toBeLessThanOrEqual(12);
    expect(maxInFlight()).toBeGreaterThan(1);

    expect(features).toHaveLength(40);
    const first = features.at(0);
    const last = features.at(39);
    expect(first === undefined ? undefined : first._id).toBe("e0");
    expect(last === undefined ? undefined : last._id).toBe("e39");
    // Byte-exact accounting: 40 payloads × their UTF-8 byte length (the old
    // `text.length` accounting counted code units instead).
    expect(payloadBytes).toBe(40 * new TextEncoder().encode(GEOMETRY_JSON).byteLength);
  });

  it("counts inline geometryJson rows toward the payload without fetching", async () => {
    setGeometryPages([
      [
        { entryId: "inline", geometryJson: GEOMETRY_JSON },
        { entryId: "fetched", geometryUrl: "https://storage.test/geo/1" },
        { entryId: "empty", geometryUrl: undefined }, // no geometry at all
      ],
    ]);
    const { fetchMock } = stubFetch();

    const { features, payloadBytes } = await fetchAllGeometryFeatures(
      {} as ConvexClient,
      "schema1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the url row
    expect(features).toHaveLength(2);
    expect(payloadBytes).toBe(2 * new TextEncoder().encode(GEOMETRY_JSON).byteLength);
  });

  it("rejects when a payload fetch fails, failing the build", async () => {
    setGeometryPages([[urlRow(0), urlRow(1)]]);
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<FakeFetchResponse>>(async () => ({
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    await expect(fetchAllGeometryFeatures({} as ConvexClient, "schema1")).rejects.toThrow(
      /Geometry payload fetch failed with HTTP/,
    );
  });
});
