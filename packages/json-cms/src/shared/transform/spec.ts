/**
 * Declarative, serializable transform-spec types for derived datasets —
 * docs/derived-datasets-design.md §§2–3: a spec records the source dataset,
 * an ordered list of operations, and (implicitly, by walking `operations`)
 * the datasets it depends on. Executing a spec never mutates base data; the
 * output is new rows (§1, §2).
 *
 * Shape rules, each load-bearing for a later stage:
 *
 * - **Serializable plain data.** No functions, classes, or symbols — stage 2
 *   stores specs as app-side documents, and stage 4's rollup and
 *   `geometrySource` (catalog-lifecycle-design.md) must join the operation
 *   union without migrating stored specs (§11). `TransformOperation` is a
 *   discriminated union on `kind`: new operations are new variants, old
 *   stored specs keep reading.
 * - **Dependencies are reachable by walking `operations`.** Every operation
 *   names the dataset it reads, so the registry's cycle rejection (stage 2,
 *   #95) needs nothing beyond the spec itself.
 * - **No lineage fields yet.** Bound-dataset lineage (§7 — pin a frozen tag
 *   vs live) is deliberately absent from this stage (#94); when it lands it
 *   is an additive optional field per source reference, which this shape
 *   leaves room for.
 */

/**
 * One operation of a `TransformSpec`. v1 carries only `LookupOperation`
 * (roadmap stage 1); rollup and `geometrySource` join as new `kind`s in
 * stage 4.
 */
export type TransformOperation = LookupOperation;

/**
 * Many-to-one enrichment (§4.1, §6): rows of the spec's source dataset gain
 * namespaced fields from one related row of `lookupDatasetId`
 * (`grants.name`, `grants.status`). Row count is unchanged under the
 * default left matching; it shrinks only by explicit inner matching.
 */
export interface LookupOperation {
  kind: "lookup";
  /** Dataset the lookup reads from — a component dataset id, stored as a plain string (the #95 registry precedent). */
  lookupDatasetId: string;
  /** Key column in the source (base) rows. Single-column in v1 (§11); a composite-key variant can join the union later without breaking this field. */
  baseKey: string;
  /** Key column in the lookup rows. */
  lookupKey: string;
  /**
   * Enrichment fields to bring in, in this order. Omitted → every field the
   * lookup table carries except `lookupKey` (the join plumbing is not
   * enrichment data), first-seen across the table. A picked field a matched
   * row lacks still lands, as null. (§11 leaves picked-vs-all open; this
   * fixes it — omit means all — and matches #96's picked-field exports,
   * which set `fields` explicitly.)
   */
  fields?: string[];
  /**
   * Namespace for brought-in fields, rendered `<namespace>.<field>` (§6).
   * Omitted → the engine falls back to `lookupDatasetId`: the engine is
   * pure and cannot resolve an id to a display name, so the spec-authoring
   * layer (stage 2) sets this explicitly whenever it knows the dataset
   * name. Either way the namespaced form keeps exports and popup labels
   * unambiguous.
   */
  namespace?: string;
  /**
   * Match policy (§6): "left" (default) keeps unmatched base rows with null
   * enriched fields; "inner" drops them — an explicit spec choice, never a
   * side effect.
   */
  match?: "left" | "inner";
  /**
   * Duplicate-key policy (§6: "must be decided, not implicit"). When
   * several lookup rows share one normalized key: "first" (default) keeps
   * the first, "last" keeps the last, "error" rejects the whole lookup.
   * The defaults are the engine's recorded decision (stage 1, #94), not an
   * accident of implementation.
   */
  onDuplicateKey?: "first" | "last" | "error";
}

/**
 * A derived-dataset transform spec (§3): the source dataset plus the
 * ordered operations producing the virtual output. Plain serializable data
 * — see the module doc above for the shape rules.
 */
export interface TransformSpec {
  /** Component dataset id the rows come from (§3; a plain string per the #95 registry precedent). */
  sourceDatasetId: string;
  /** Operations applied in order; each consumes the previous operation's rows. */
  operations: TransformOperation[];
}
