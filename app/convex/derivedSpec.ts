/**
 * Pure helpers behind the derived-dataset registry (roadmap stage 2, #95;
 * ADR 0005 §§3,6). Three jobs, all deliberately Convex-free so
 * `derivedSpec.test.ts` can exercise them with stand-ins (the
 * versioning.test.ts pattern) and the registry module stays a thin shell
 * over them:
 *
 * 1. **Dependency walking** (`specDependencies`) — the persisted
 *    `dependsOn` edges are denormalized from the spec at save time. The
 *    spec itself carries everything (spec.ts:16-19); this only flattens it.
 * 2. **Cycle rejection** (`findCycleToOrigin`) — §3: derived-of-derived
 *    forms a DAG; cycles are rejected at spec-save time. The engine has
 *    none of this by design (lookup.ts:38-40). Only registry rows can
 *    close a cycle — component dataset ids are opaque strings that cannot
 *    point back — so the walk follows registry rows and stops anywhere
 *    else.
 * 3. **Staleness** (`specStatus`) — the issue's mark-on-event vs
 *    compute-on-read decision, made here: the app has no hook into the
 *    component's import completion (handleImportComplete is server-side
 *    inside the component) and dataset deletion goes straight through the
 *    exposed `deleteSchema`, so there is no event to mark on. Staleness is
 *    therefore DERIVED at read time by this one function — the single
 *    signal stages 3-6 consume — comparing a spec's declared key/field
 *    columns against the referenced datasets' current declared structures.
 *
 * The spec shapes here are structural (`TransformSpecLike`), not the
 * component's interfaces: the registry stores specs as `v.any()` (the
 * schemaMapping precedent) and must keep tolerating operation kinds that
 * only stage 4 will introduce, so importing today's union would oversell
 * what the stored data is guaranteed to be. Anything shapeless is simply
 * not an edge.
 */

/** A stored spec, read structurally (see the module doc). */
export interface TransformSpecLike {
  operations?: unknown;
  sourceDatasetId?: unknown;
}

/** One computed health reading for a registry row. */
export type DerivedHealth = "orphaned" | "ready" | "stale";

/** `specStatus`'s result: the health state plus a human-readable reason when it isn't "ready". */
export interface HealthReport {
  health: DerivedHealth;
  reason?: string;
}

/** What a referenced dataset resolves to for the walks — built by the registry module from ctx. */
export type ReferencedDataset =
  | { kind: "component"; properties: string[]; title: string }
  | { kind: "missing"; title?: string }
  | { kind: "registry"; spec: unknown; title: string };

/** A registry row's persisted dependency edges — the cycle walk's input (the save mutation denormalizes them from the spec). */
export interface RegistryRowLike {
  dependsOn: string[];
}

export type DatasetResolver = (id: string) => Promise<ReferencedDataset>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The declared top-level properties of a stored JSON Schema document — the
 * key/field names staleness checks against. Tolerant: anything without an
 * object `properties` maps has no declared columns (the component's
 * `storedSchemaFieldCount` reads the same shape, packages/json-cms
 * `lib.ts`).
 */
export function schemaProperties(schemaJson: unknown): string[] {
  if (!isRecord(schemaJson)) {
    return [];
  }
  const properties = schemaJson.properties;
  if (!isRecord(properties)) {
    return [];
  }
  return Object.keys(properties);
}

/**
 * The datasets a spec reads — `dependsOn`'s content: the source first, then
 * each operation's dataset in order, distinct, first-seen. Lookup
 * operations name their dataset in `lookupDatasetId`; a future operation
 * kind joins this walk additively when it lands (stage 4) — today it
 * simply contributes no edge, which is the additive tolerance the v.any()
 * storage demands.
 */
export function specDependencies(spec: TransformSpecLike): string[] {
  const deps: string[] = [],
    seen = new Set<string>(),
    push = (value: unknown) => {
      if (typeof value === "string" && value !== "" && !seen.has(value)) {
        seen.add(value);
        deps.push(value);
      }
    };
  push(spec.sourceDatasetId);
  if (Array.isArray(spec.operations)) {
    for (const operation of spec.operations) {
      if (isRecord(operation)) {
        push(operation.lookupDatasetId);
      }
    }
  }
  return deps;
}

/** The parts of a spec the save path may rely on once `validateSpecShape` accepts it. */
export interface WellFormedSpec {
  operations: unknown[];
  sourceDatasetId: string;
}

export type SpecValidation = { ok: false; reason: string } | { ok: true; spec: WellFormedSpec };

/**
 * Structural sanity for a client-supplied spec, at save time. Deliberately
 * NARROW: it rejects only what the engine itself cannot run or the
 * persisted edges depend on (a non-empty string source, operation records
 * with a kind, lookup ops carrying their three string columns). Unknown
 * operation kinds pass untouched — stage 4 adds kinds, and a validator
 * here must never be the thing that forces a stored-spec migration
 * (spec.ts:13-15). Accepts with the narrowed `WellFormedSpec` view (so the
 * caller never asserts), rejects with a user-facing reason.
 */
/** The lookup op's three required columns — reason, or undefined. */
function lookupColumnsError(operation: Record<string, unknown>): string | undefined {
  for (const column of ["baseKey", "lookupDatasetId", "lookupKey"]) {
    const cell = operation[column];
    if (typeof cell !== "string" || cell === "") {
      return `A lookup operation is missing its ${column}.`;
    }
  }
  return undefined;
}

/** The lookup op's optional cells — reason, or undefined. */
function lookupOptionsError(operation: Record<string, unknown>): string | undefined {
  if (
    operation.fields !== undefined &&
    (!Array.isArray(operation.fields) ||
      operation.fields.some((field) => typeof field !== "string" || field === ""))
  ) {
    return `A lookup operation's fields must be a list of column names.`;
  }
  return matchPolicyError(operation.match) ?? duplicatePolicyError(operation.onDuplicateKey);
}

/** The match policy cell — reason, or undefined. */
function matchPolicyError(match: unknown): string | undefined {
  if (match !== undefined && match !== "inner" && match !== "left") {
    return `A lookup operation's match must be "left" or "inner".`;
  }
  return undefined;
}

/** The duplicate-key policy cell — reason, or undefined. */
function duplicatePolicyError(onDuplicateKey: unknown): string | undefined {
  if (
    onDuplicateKey !== undefined &&
    onDuplicateKey !== "error" &&
    onDuplicateKey !== "first" &&
    onDuplicateKey !== "last"
  ) {
    return `A lookup operation's onDuplicateKey must be "first", "last", or "error".`;
  }
  return undefined;
}

/** One operation record — reason, or undefined when it passes (unknown kinds pass untouched). */
function operationError(operation: unknown): string | undefined {
  if (!isRecord(operation)) {
    return "Every transform operation must be an object.";
  }
  if (typeof operation.kind !== "string" || operation.kind === "") {
    return "Every transform operation must declare its kind.";
  }
  if (operation.kind !== "lookup") {
    return undefined;
  }
  return lookupColumnsError(operation) ?? lookupOptionsError(operation);
}

export function validateSpecShape(value: unknown): SpecValidation {
  if (!isRecord(value)) {
    return { ok: false, reason: "The transform spec must be an object." };
  }
  if (typeof value.sourceDatasetId !== "string" || value.sourceDatasetId === "") {
    return { ok: false, reason: "The transform spec must name a source dataset." };
  }
  if (!Array.isArray(value.operations)) {
    return { ok: false, reason: "The transform spec must carry an operations array." };
  }
  for (const operation of value.operations) {
    const error = operationError(operation);
    if (error !== undefined) {
      return { ok: false, reason: error };
    }
  }
  return { ok: true, spec: { operations: value.operations, sourceDatasetId: value.sourceDatasetId } };
}

/**
 * Follows `startIds` (the saved spec's dependencies) through registry rows
 * only, reporting the first dataset that closes a chain back to
 * `originId` — the row being saved. Each hop reads the row's PERSISTED
 * `dependsOn` edges, not a re-parse of its stored spec. Inserts can never
 * cycle (a brand-new id cannot already be referenced), so callers walk
 * updates only. Shared DAG branches are visited once, so diamonds stay
 * linear in the walk.
 */
export async function findCycleToOrigin(
  originId: string,
  startIds: string[],
  lookupRegistryRow: (id: string) => Promise<RegistryRowLike | null>,
): Promise<string | undefined> {
  const visited = new Set<string>(),
    stack = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || visited.has(id)) {
      continue;
    }
    visited.add(id);
    if (id === originId) {
      return id;
    }
    // oxlint-disable-next-line no-await-in-loop -- the walk is a frontier traversal; each row decides whether the chain continues.
    const row = await lookupRegistryRow(id);
    if (row !== null) {
      stack.push(...row.dependsOn);
    }
  }
  return undefined;
}

/** A stored spec value as the structural view the health walk reads. */
function asSpec(value: unknown): TransformSpecLike {
  return isRecord(value) ? value : {};
}

/**
 * Compute-on-read staleness for one spec (see the module doc): "orphaned"
 * when a referenced dataset is gone, "stale" when a declared key or picked
 * field no longer exists on the referenced dataset's declared structure.
 * References to other registry rows inherit transitively — a derived
 * source whose own spec went stale makes this spec stale too. A derived
 * reference has no static columns to compare (its output is computed), so
 * only existence and its own health are checked there. The first problem
 * found wins; a healthy spec answers "ready".
 */
export async function specStatus(
  spec: TransformSpecLike,
  resolve: DatasetResolver,
): Promise<HealthReport> {
  return statusOfSpec(spec, resolve, new Set<string>());
}

/** The lookup reads a spec makes, collected for the health walk: the source's `baseKey`s plus each operation's lookup side. */
function collectReads(spec: TransformSpecLike): {
  baseKeys: string[];
  lookups: Array<{ fields: string[] | undefined; id: string; lookupKey: string[] }>;
} {
  const baseKeys: string[] = [],
    lookups: Array<{ fields: string[] | undefined; id: string; lookupKey: string[] }> = [];
  if (!Array.isArray(spec.operations)) {
    return { baseKeys, lookups };
  }
  for (const operation of spec.operations) {
    if (!isRecord(operation) || operation.kind !== "lookup") {
      continue;
    }
    if (typeof operation.baseKey === "string" && !baseKeys.includes(operation.baseKey)) {
      baseKeys.push(operation.baseKey);
    }
    lookups.push({
      fields: stringArrayOrUndefined(operation.fields),
      id: typeof operation.lookupDatasetId === "string" ? operation.lookupDatasetId : "",
      lookupKey: typeof operation.lookupKey === "string" ? [operation.lookupKey] : [],
    });
  }
  return { baseKeys, lookups };
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((field): field is string => typeof field === "string");
}

async function statusOfSpec(
  spec: TransformSpecLike,
  resolve: DatasetResolver,
  visited: Set<string>,
): Promise<HealthReport> {
  if (typeof spec.sourceDatasetId !== "string" || spec.sourceDatasetId === "") {
    return { health: "orphaned", reason: "This spec no longer names its source dataset." };
  }
  const { baseKeys, lookups } = collectReads(spec),
    source = await statusOfReference(
      spec.sourceDatasetId,
      "source dataset",
      baseKeys,
      undefined,
      resolve,
      visited,
    );
  if (source.health !== "ready") {
    return source;
  }
  for (const lookup of lookups) {
    // oxlint-disable-next-line no-await-in-loop -- the walk stops at the first unhealthy reference; order is the point.
    const report = await statusOfReference(
      lookup.id,
      "related dataset",
      lookup.lookupKey,
      lookup.fields,
      resolve,
      visited,
    );
    if (report.health !== "ready") {
      return report;
    }
  }
  return { health: "ready" };
}

async function statusOfReference(
  id: string,
  role: string,
  keys: string[],
  fields: string[] | undefined,
  resolve: DatasetResolver,
  visited: Set<string>,
): Promise<HealthReport> {
  if (id === "") {
    return { health: "orphaned", reason: `A lookup operation no longer names its ${role}.` };
  }
  const referenced = await resolve(id);
  if (referenced.kind === "missing") {
    return {
      health: "orphaned",
      reason: `The ${role} this spec reads${
        referenced.title === undefined ? "" : ` ("${referenced.title}")`
      } no longer exists.`,
    };
  }
  if (referenced.kind === "registry") {
    // Derived-of-derived: inherit the referenced spec's own health. The
    // save gate rejects cycles, so the visited set is defensive only — a
    // revisit (impossible today) reads as satisfied rather than looping.
    if (visited.has(id)) {
      return { health: "ready" };
    }
    visited.add(id);
    const report = await statusOfSpec(asSpec(referenced.spec), resolve, visited);
    if (report.health !== "ready") {
      return {
        health: report.health,
        reason: `Depends on "${referenced.title}", which is ${report.health}: ${report.reason ?? "unspecified"}.`,
      };
    }
    return { health: "ready" };
  }
  // A component dataset: compare declared columns. (A dataset with no
  // declared properties — e.g. schemaless — can only pass; there is
  // nothing to compare against.)
  return componentHealth(referenced, keys, fields);
}

/** The stale check against one component dataset's declared structure. */
function componentHealth(
  referenced: { properties: string[]; title: string },
  keys: string[],
  fields: string[] | undefined,
): HealthReport {
  const properties = referenced.properties,
    missingKey = keys.find((key) => !properties.includes(key));
  if (missingKey !== undefined) {
    return {
      health: "stale",
      reason: `Column "${missingKey}" no longer exists on "${referenced.title}".`,
    };
  }
  if (fields !== undefined) {
    const missingField = fields.find((field) => !properties.includes(field));
    if (missingField !== undefined) {
      return {
        health: "stale",
        reason: `Picked field "${missingField}" no longer exists on "${referenced.title}".`,
      };
    }
  }
  return { health: "ready" };
}
