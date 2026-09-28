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
 * - **One engine interface, shared with the stage 9 SQL layer (§11:252-255,
 *   issue #98 AC 4).** Each operation kind pairs (a) a serializable spec
 *   variant in this union with (b) one pure engine function over generic
 *   records — `(operation, rows, sideTables) → { rows, diagnostics }` —
 *   that never mutates its inputs, returns fresh rows, does no I/O, and
 *   imports nothing but `../coercion.js` and the types in this module.
 *   `applyLookup` (lookup.ts) and `applyRollup` (rollup.ts) are the stage 1
 *   and 4 implementations; a SQL-backed operation
 *   (docs/analysis-layer-design.md) joins as another `kind` implementing the
 *   same contract, its spec plain serializable data. Diagnostics stay
 *   operation-shaped — each kind records its own — so there is no shared
 *   result contract a SQL layer would have to fake, only the function
 *   shape, purity, and serializability.
 */

/**
 * One operation of a `TransformSpec`. Stage 4 (#98) added `RollupOperation`
 * alongside `LookupOperation`; later kinds (the stage 9 SQL layer,
 * §11:252-255) join the same way — new variants, old stored specs keep
 * reading (spec.ts:13-15).
 */
export type TransformOperation = LookupOperation | RollupOperation;

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
 * One aggregate of a `RollupOperation` group (§4.2). `fn` names the
 * aggregate function — a plain string, never a function value (shape rule
 * 1). The doc-fixed set is exactly six (design doc:99-100): count, sum,
 * avg, min, max, distinct count. Nothing else joins without a stage decision
 * (§2:75-77 — the primitive set stays two operations deep).
 *
 * `alias` is the author's name for the measure; the output column is
 * `<namespace>.<alias>` (see `RollupOperation.namespace`) so exports and
 * popup labels stay unambiguous (§6, issue decision 6).
 */
export type RollupMeasure =
  /** Row count of the group — COUNT(*): every grouped row counts (recorded decision, rollup.ts). */
  | { alias: string; fn: "count" }
  /**
   * Aggregate the group's cells of `column` numerically. Cells go through
   * the 0.4 `coerceNumber` policy (a numeric column's string cells count:
   * "42" is 42); cells with no numeric value are excluded, never an error.
   * A group with no numeric cells yields null for each of these — the
   * recorded null semantics (rollup.ts), not a fabricated 0.
   */
  | { alias: string; column: string; fn: "sum" | "avg" | "min" | "max" }
  /**
   * Distinct count of the group's `column` cells, counted on their
   * NORMALIZED KEYS (`normalizeKey`) — the same identity the grouping
   * itself uses, so "Aldine" and "aldine" count once. Cells with no key
   * contribute nothing; a group with no keyed cells yields 0.
   */
  | { alias: string; column: string; fn: "distinctCount" };

/**
 * Group-by aggregation (§4.2, stage 4 #98): group the rows already in the
 * pipeline by one or more key columns — explicitly MULTI-key, unlike v1's
 * single-column join keys (§11:235-236; the asymmetry is the issue's
 * decision 1) — and compute measures. The operation names no dataset: it
 * consumes the previous operation's rows (or the spec's source, when
 * alone), so it contributes no dependency edge (the additive tolerance
 * app/convex/derivedSpec.ts:84-90 was written for) and its output is small
 * — one row per group — and immediately re-joinable into a parent dataset
 * (§3:87-90, the composition this issue exists for).
 */
export interface RollupOperation {
  kind: "rollup";
  /**
   * Key columns to group by, coerced per cell through `normalizeKey`
   * (0.4's utilities, the same function the lookup engine joins with).
   * Case-folded, so "Aldine" and "aldine" form one group. A row lacking a
   * key in ANY listed column has no group and is dropped — counted in
   * `applyRollup`'s diagnostics (the recorded decision; rollup.ts). An
   * EMPTY array is the total aggregate: one group of all rows.
   */
  groupBy: string[];
  /**
   * Measures to compute per group. Empty → the output is the distinct-group
   * projection (key columns only) — recorded, rollup.ts.
   */
  measures: RollupMeasure[];
  /**
   * Namespace for measure columns, rendered `<namespace>.<alias>` (§6).
   * Omitted → "rollup". The group-key columns keep their SOURCE names and
   * raw first-seen values, so the join-back key resolves unambiguously
   * (issue decision 6): a downstream lookup names the same column on both
   * sides.
   */
  namespace?: string;
}

/**
 * A transform spec's geometry rule (catalog-lifecycle-design.md §5.2:134-139,
 * stage 4 #98 decision 3): a join table has no coordinates — the point
 * geometry comes from one side of one lookup operation — so the spec names
 * which op/side/column carries it. Spec-level (singular per spec), never
 * per-operation. Addresses LOOKUP operations only: a rollup collapses rows,
 * so a group has no single source row's geometry to resolve (recorded,
 * lookup.ts). Two consumers share the shape: 3a rendering (which dataset's
 * geometry rows to draw) and 5b materialization (which joined rows'
 * geometryIds are written into the published entries). The engine's
 * `geometryReferences` pair with the rows of the ONE applyLookup call that
 * resolved the rule — so consumers resolve it AT THE GEOMETRY OP'S POSITION
 * (`geometrySourceOperationOf` finds that op) and consume that call's rows;
 * a later operation that changes row count (e.g. `match: "inner"` — the
 * canonical §5.2 join chains a second lookup) shifts indices, and no
 * previously emitted array adjusts (constraint recorded on lookup.ts's
 * geometry bullet, pinned by test in composition.test.ts).
 *
 * Confirm-before-freezing note (issue decision 3): this TS shape is the
 * stage 4 implementer's proposal, recorded here and in #98 — it is plain
 * serializable data, so refining it later is an additive change, never a
 * stored-spec migration.
 */
export interface GeometrySource {
  /**
   * The lookup operation whose side carries the geometry, named by its
   * `lookupDatasetId` ("geometry from the locations lookup side", §5.2).
   * When several lookup operations share one dataset id, the rule addresses
   * the FIRST in operation order — the tiebreak `geometrySourceOperationOf`
   * implements, so prose and code cannot drift.
   */
  lookupDatasetId: string;
  /** Which side of that operation the geometry lives on. */
  side: "base" | "lookup";
  /**
   * Column on that side's rows whose value is the geometry reference (for
   * entries, a geometryId). Read raw — a reference is data, not a key —
   * and absent cells resolve to null, never an error.
   */
  column: string;
}

/**
 * The lookup operation a `geometrySource` rule addresses, or `undefined`
 * when none does — the addressing rule of `GeometrySource` as code, so 3a
 * and 5b don't each re-derive it from prose: the FIRST lookup operation (in
 * order, rollups skipped — they name no dataset) whose `lookupDatasetId`
 * matches the rule's. `undefined` is the detectable form of a silently
 * inert rule (a typo'd dataset id, or a spec with no such lookup side):
 * consumers treat it as "this spec carries no resolvable geometry rule",
 * never as a crash.
 */
export function geometrySourceOperationOf(
  operations: readonly TransformOperation[],
  geometrySource: GeometrySource,
): LookupOperation | undefined {
  for (const operation of operations) {
    if (
      operation.kind === "lookup" &&
      operation.lookupDatasetId === geometrySource.lookupDatasetId
    ) {
      return operation;
    }
  }
  return undefined;
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
  /**
   * The spec's geometry rule (§5.2 — see `GeometrySource`). Optional and
   * additive: stored specs without it keep reading (shape rule 1). Inert
   * until a consumer lands — 3a rendering and 5b materialization read it;
   * the map layer's bottom-source walk keeps its current behavior until
   * then (map-layers.ts:107-126).
   */
  geometrySource?: GeometrySource;
}

/**
 * The datasets a spec reads, in order: the source first, then each lookup
 * operation's dataset, distinct, first-seen — the content the registry's
 * save-time `dependsOn` denormalizes (app/convex/derivedSpec.ts:92-110) and
 * its cycle walk then follows through persisted rows (`findCycleToOrigin`).
 * This is the engine's union-aware statement of that walk's input (issue
 * #98 AC 2): rollup operations name NO dataset — they group rows already in
 * the pipeline — so they contribute no edge, which is exactly the additive
 * behavior derivedSpec.ts:84-90 reserved for stage 4, and a
 * `geometrySource` names a side of an operation the spec already carries,
 * so it adds no edge either. The walk itself stays registry-side (only
 * registry rows can close a cycle — component ids are opaque strings); this
 * function is the edge-computer its persisted edges are built from.
 */
export function transformSpecDependencies(
  spec: Pick<TransformSpec, "sourceDatasetId" | "operations">,
): string[] {
  const dependencies: string[] = [],
    seen = new Set<string>(),
    push = (value: unknown): void => {
      if (typeof value === "string" && value !== "" && !seen.has(value)) {
        seen.add(value);
        dependencies.push(value);
      }
    };
  push(spec.sourceDatasetId);
  for (const operation of spec.operations) {
    if (operation.kind === "lookup") {
      push(operation.lookupDatasetId);
    }
  }
  return dependencies;
}
