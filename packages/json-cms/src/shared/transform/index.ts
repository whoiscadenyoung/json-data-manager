/**
 * The React-free transform surface (roadmap stage 3b, issue #97): the pure
 * engine and its spec types, importable WITHOUT the `@caden/json-cms/react`
 * barrel — whose react + convex/react + query-bridge imports must never
 * reach React-free bundles (the row-resolution seam is shared with the
 * tile-archive web worker). Identical re-exports to the react barrel's
 * stage 1 block; the two cannot drift because both point at these modules.
 */
export { applyLookup, LookupKeyConflictError } from "./lookup.js";
export type { LookupDiagnostics, LookupResult } from "./lookup.js";
export type { LookupOperation, TransformOperation, TransformSpec } from "./spec.js";
