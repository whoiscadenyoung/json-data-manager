/**
 * The pure version-row join rule (roadmap stage 6, #101) — deliberately
 * import-free so BOTH the server's delta machinery (app/convex/versioning.ts,
 * which re-exports these) and the client's row-resolution seam
 * (app/src/lib/dataset-rows.ts) key version rows with ONE definition. The
 * diff's ops (the server's `diffVersionRows`) and the diff overlay's
 * positioning rows (the seam's version reader) only line up if both sides
 * derive the same key, which is why this lives in its own module instead of
 * either side.
 */

/** One light {key, data} version row — the diff's unit. */
export type VersionRow = { data: Record<string, unknown>; key: string };

/** The natural display key of a version entry (the diff's join key). */
export function naturalKeyOf(data: Record<string, unknown>): string | undefined {
  if (typeof data.label === "string") {
    return data.label;
  }
  if (typeof data.name === "string") {
    return data.name;
  }
  return undefined;
}

/** One entry row as a light version row, keyed by `naturalKeyOf` (entry id fallback). */
export function versionRowOf(entryId: string, data: unknown): VersionRow | undefined {
  // Non-record rows stay out of a diff — the server's `versionRows` applies
  // the same rule before keying.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the guards right below enforce the record shape at runtime (the versionRows pattern).
  const record = data as Record<string, unknown> | null;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  return { data: record, key: naturalKeyOf(record) ?? entryId };
}
