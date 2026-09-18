/**
 * Which Convex query namespaces are allowed into persisted light state
 * (issue #58 part 5). Kept free of imports so it stays testable in isolation;
 * `root-provider.tsx` applies it via `shouldDehydrateQuery`.
 *
 * Geometry payloads are the exclusion that matters: the tile path bypasses
 * the query cache entirely, and the geometry-page queries (`geometries:*`)
 * are deliberately absent even for row-path datasets — persisted state is for
 * instant tables, never megabytes of shapes.
 */
const LIGHT_QUERY_NAMESPACES = [
  "collections",
  "entries",
  "groups",
  "maps",
  "schemas",
  "tile_archives",
];

export function isPersistableQueryName(name: string): boolean {
  return LIGHT_QUERY_NAMESPACES.some(
    (namespace) => name === namespace || name.startsWith(`${namespace}:`),
  );
}

/** Query hashes from `ConvexQueryClient.hashFn` look like
 * `convexQuery|module:function|{argsJson}` — the name is the second segment. */
export function isPersistableQueryHash(queryHash: string): boolean {
  const [kind, name] = queryHash.split("|");
  return kind === "convexQuery" && name !== undefined && isPersistableQueryName(name);
}
