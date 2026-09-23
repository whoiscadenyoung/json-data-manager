/**
 * On-demand geometry-row materialization (issue #58 part 4).
 *
 * Datasets rendering from tile archives never fetch their geometry rows
 * (that's the point) — but exports and entry-edit prefill still need the
 * full payloads. These helpers materialize them lazily: a paginated read
 * to exhaustion, then resolve every row to a `Geometry`. Both are
 * async one-shots for imperative call sites (export confirm handlers), not
 * hooks — a tile-path dataset's rows should never become a standing
 * subscription.
 */
import type { Geometry } from "@caden/json-cms/react";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import { env } from "#/env";
import { api } from "#convex/_generated/api";
import { fetchConvexToken } from "#/lib/convex-auth-token";

/** One geometry row, as `api.geometries.list` paginates it. */
export type GeometryRow = FunctionReturnType<typeof api.geometries.list>["page"][number];

// A second client (alongside the app provider's ConvexReactClient) would only
// matter under load; exports materialize rarely, and `ConvexClient` shares
// the worker's proven pattern for imperative one-shot calls.
let client: ConvexClient | undefined;

function sharedClient(): ConvexClient {
  client ??= new ConvexClient(env.VITE_CONVEX_URL);
  // Identity for the sign-in gate — re-asserted per call so a client first
  // created signed out still authenticates once the session exists.
  client.setAuth(fetchConvexToken);
  return client;
}

/**
 * Pages `api.geometries.list` to exhaustion — the rebuild worker's
 * completeness loop, on the main thread, only when the data is actually
 * asked for. Sequential pages resume from the previous cursor.
 */
export async function fetchAllGeometryRows(schemaId: string): Promise<GeometryRow[]> {
  const convex = sharedClient(),
    rows: GeometryRow[] = [];
  let cursor = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor; inherently sequential.
    const page = await convex.query(api.geometries.list, {
      paginationOpts: { cursor, numItems: 500 },
      schemaId,
    });
    rows.push(...page.page);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return rows;
}

/** One dataset's resolved geometry entries, materialized on demand for an export. */
export async function resolveDatasetGeometryRows(
  schemaId: string,
): Promise<Array<[string, Geometry]>> {
  return [...(await resolveGeometryRows(await fetchAllGeometryRows(schemaId))).entries()];
}

async function fetchGeometryPayload(url: string): Promise<Geometry> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch geometry (HTTP ${response.status}).`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a Convex storage URL for a geometry payload, which was validated as a real `Geometry` server-side at write time.
  return (await response.json()) as Geometry;
}

/**
 * Resolves rows to `Geometry` values keyed by the geometry row id — the same
 * keying `useResolvedGeometries` produces and `buildGeoJsonCollection`
 * consumes. Inline rows parse synchronously; externally-stored rows fetch in
 * parallel. A malformed or failed row leaves its geometry unresolved (the
 * export shows `null` geometry) instead of failing the whole export.
 */
export async function resolveGeometryRows(
  rows: GeometryRow[],
): Promise<globalThis.Map<string, Geometry>> {
  const resolved = new globalThis.Map<string, Geometry>();
  await Promise.all(
    rows.map(async (row) => {
      try {
        if (row.geometryJson !== undefined) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated as a real `Geometry` server-side at write time.
          resolved.set(row._id, JSON.parse(row.geometryJson) as Geometry);
        } else if (row.geometryUrl !== undefined) {
          resolved.set(row._id, await fetchGeometryPayload(row.geometryUrl));
        }
      } catch {
        // Leave this row unresolved; everything else still exports.
      }
    }),
  );
  return resolved;
}
