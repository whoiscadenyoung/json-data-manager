/**
 * Which query namespaces are allowed into persisted light state (issue #58
 * part 5; design doc §8.2). Kept
 * free of imports so it stays testable in isolation; `root-provider.tsx`
 * applies it via `shouldDehydrateQuery`.
 *
 * The store modules key their queries `["<table>", <fn>, args]`, so the
 * first key element is the namespace. Bump `PERSIST_KEY` when the persisted
 * namespaces change shape, so an older cache is never restored.
 *
 * Geometry payloads are the exclusion that matters: the tile path bypasses
 * the query cache entirely, and the geometry-row queries (`geometries`)
 * are deliberately absent even for row-path datasets — persisted state is
 * for instant tables, never megabytes of shapes.
 */
const LIGHT_QUERY_NAMESPACES = ["collections", "datasets", "entries", "groups", "maps"];

export function isPersistableQueryName(name: string): boolean {
  return LIGHT_QUERY_NAMESPACES.some(
    (namespace) => name === namespace || name.startsWith(`${namespace}:`),
  );
}

/** Query hashes are TanStack's default JSON key form: `["entries","listPage",{…}]` —
 * the namespace is the first key element. */
export function isPersistableQueryHash(queryHash: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(queryHash) as unknown;
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }
  const namespace = parsed[0];
  return typeof namespace === "string" && isPersistableQueryName(namespace);
}
