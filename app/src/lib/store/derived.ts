import type { SupabaseClient } from "@supabase/supabase-js";
import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * The derived-datasets store (design doc §8.1 "derived.ts # derivedDatasets
 * registry CRUD + status"; stage 5, issue #204) — the PG counterpart of the
 * Convex `derivedDatasets` registry (app/convex/versions/derivedDatasets.ts,
 * READ-ONLY parity source) over the `public.derived_datasets` table (DDL
 * §3.5, migration 0009; RLS tightened to the Convex rules in 0010).
 *
 * What the backend owns — then and now — is exactly what ADR 0005 gives it:
 * the catalog of specs, save-time structural sanity + cycle rejection over
 * the persisted `depends_on` edges, and read-time staleness. The SPECS
 * THEMSELVES are computed through the row-resolution seam
 * (`dataset-rows-pg.ts` — `applyEntryRowSpecs` inside its read functions);
 * this module never executes a transform.
 *
 * Analyses are rows of this registry too (sql op kind — "an analysis is a
 * registry row", the stage-9 precedent; §8.1's `analysis.ts` naming has no
 * separate table to sit on, so its registry reads are these reads, filtered
 * client-side by `specCarriesSql` like the Convex summary's `carriesSql`).
 *
 * Parity notes (each traces to the Convex registry module):
 *   - `save` is the builder's upsert: status "draft" (autosave) and "saved"
 *     (explicit Save) land here; title is the only required field; the spec
 *     is validated STRUCTURALLY (`validateSpecShape`, pinned copy below) and
 *     never narrowed to today's operation union; `source_dataset_id` /
 *     `source_derived_id` are kept in lockstep with `spec.sourceDatasetId`
 *     so a retargeted spec never files under a source it no longer reads.
 *   - Cycle rejection walks the persisted `depends_on` edges through other
 *     registry rows only (`findCycleToOrigin`, pinned copy below); only an
 *     update can close a cycle, so inserts skip the walk.
 *   - Read scoping rides RLS (migration 0010): SAVED rows are visible to
 *     every signed-in viewer, DRAFTS to their creator alone — which is the
 *     Convex stage-8 split ("drafts are creator-private on every read",
 *     "SAVED rows are catalog-visible") expressed as row-level security
 *     instead of query legs. `get` answers null for an invisible foreign
 *     draft exactly like the Convex `get`; `listBySource`'s Convex two-leg
 *     merge (issue #128's index split) collapses into ONE RLS-scoped read,
 *     because foreign drafts can no longer crowd the window — saved rows and
 *     the caller's own rows are the only ones the database hands back.
 *   - Writes are creator-scoped by the same policies; an RLS-filtered
 *     update/delete answers 0 rows (the stage-4 silent-denial rule), which
 *     `save`/`remove` surface instead of toasting success.
 *
 * Health ("orphaned" / "ready" / "stale") is COMPUTED ON READ by the pinned
 * `specStatus` walk over one shared per-call resolver memo (the issue #128
 * shape): there is no import-completion hook to mark on, and dataset
 * deletion goes straight through the FK cascades, so staleness is derived,
 * never stored.
 *
 * Stage-7 parity fixes (the tranche-3 recorded-not-fixed findings, owned by
 * this stage): the save now walks `specDependencies` through RLS-scoped
 * reads (assertNewDependenciesVisible — the Convex
 * assertSpecDependenciesVisible gate, closing the foreign-draft reference
 * hole AND the cross-user cycle hole), and save/remove sync the saved spec's
 * consumer_references float edges (syncConsumerReferenceEdges — the Convex
 * syncRegistryReferenceEdges port). Deltas recorded inline: the refusal
 * copy is table-neutral (RLS cannot name which table hides an id), and the
 * edges cover dataset dependencies only (the PG FK on
 * consumer_references.source_dataset_id cannot represent a registry row).
 *
 * NOTE: narrow local interfaces typed from the design doc's DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

// ---------------------------------------------------------------------------
// Pinned copies — app/convex/versions/derivedSpec.ts, UNCHANGED.
//
// The registry's save gate (`validateSpecShape`), its persisted edges
// (`specDependencies`), the cycle walk (`findCycleToOrigin`), and the
// read-time health walk (`specStatus` + its helpers) are pure functions the
// Convex module carried; they are copied here verbatim (comments included)
// because the app cannot import from `app/convex/`. Their semantics are
// PINNED — the same rule `dataset-rows-pg.ts`'s spec-application step is
// pinned by: any drift between these copies and the Convex originals is a
// bug to fix in the copy, never a semantics change.
// ---------------------------------------------------------------------------

/** A stored spec, read structurally (the derivedSpec.ts module-doc rule: storage is shapeless and must stay readable across everything any stage stores). */
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

/** What a referenced dataset resolves to for the walks — built by `pgDatasetResolver` from a client. */
export type ReferencedDataset =
  | { kind: "component"; properties: string[]; title: string }
  | { kind: "missing"; title?: string }
  | { kind: "registry"; spec: unknown; title: string };

/** A registry row's persisted dependency edges — the cycle walk's input (the save path denormalizes them from the spec). */
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
 * object `properties` maps has no declared columns. (The PG store reads the
 * dataset's maintained `properties` column directly — the same keys the
 * Convex walk derived from the schema payload — so this copy stays for the
 * payload-shaped inputs the health walk's own tests feed it.)
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
 * The datasets a spec reads — `depends_on`'s content: the source first, then
 * each operation's dataset in order, distinct, first-seen. Lookup
 * operations name their dataset in `lookupDatasetId`; rollup names none
 * (rows already in the pipeline); the sql kind names its joined datasets in
 * a `tables` array of `{datasetId, as}` refs — read structurally so a
 * query's datasets contribute their edges.
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
      if (!isRecord(operation)) {
        continue;
      }
      push(operation.lookupDatasetId);
      if (Array.isArray(operation.tables)) {
        for (const table of operation.tables) {
          if (isRecord(table)) {
            push(table.datasetId);
          }
        }
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
 * operation kinds pass untouched — a validator here must never be the thing
 * that forces a stored-spec migration.
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

/** The duplicate-key policy cell — reason, or undefined. "collect" joins the union as the non-lossy 1-N policy (ADR 0026 / #288). */
function duplicatePolicyError(onDuplicateKey: unknown): string | undefined {
  if (
    onDuplicateKey !== undefined &&
    onDuplicateKey !== "error" &&
    onDuplicateKey !== "first" &&
    onDuplicateKey !== "last" &&
    onDuplicateKey !== "collect"
  ) {
    return `A lookup operation's onDuplicateKey must be "first", "last", "error", or "collect".`;
  }
  return undefined;
}

/** The sql op's required columns — reason, or undefined (narrow, like the lookup checks). */
function sqlColumnsError(operation: Record<string, unknown>): string | undefined {
  if (typeof operation.sql !== "string" || operation.sql.trim() === "") {
    return "A SQL operation is missing its query.";
  }
  return undefined;
}

/** The sql op's table refs — reason, or undefined. REQUIRED (the dependency walk reads edges from it), and each ref must carry its dataset id and SQL name. */
function sqlTablesError(operation: Record<string, unknown>): string | undefined {
  if (!Array.isArray(operation.tables)) {
    return `A SQL operation needs its list of dataset references (one per joined table, empty for none).`;
  }
  for (const table of operation.tables) {
    if (!isRecord(table)) {
      return `A SQL operation's tables must be a list of dataset references.`;
    }
    for (const column of ["as", "datasetId"] as const) {
      const cell = table[column];
      if (typeof cell !== "string" || cell === "") {
        return `A SQL operation's table references are missing their ${column}.`;
      }
    }
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
  if (operation.kind === "lookup") {
    return lookupColumnsError(operation) ?? lookupOptionsError(operation);
  }
  if (operation.kind === "sql") {
    return sqlColumnsError(operation) ?? sqlTablesError(operation);
  }
  return undefined;
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
  return {
    ok: true,
    spec: { operations: value.operations, sourceDatasetId: value.sourceDatasetId },
  };
}

/**
 * Follows `startIds` (the saved spec's dependencies) through registry rows
 * only, reporting the first dataset that closes a chain back to
 * `originId` — the row being saved. Each hop reads the row's PERSISTED
 * `depends_on` edges, not a re-parse of its stored spec. Inserts can never
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
 * Compute-on-read staleness for one spec: "orphaned" when a referenced
 * dataset is gone, "stale" when a declared key or picked field no longer
 * exists on the referenced dataset's declared structure. References to
 * other registry rows inherit transitively — a derived source whose own
 * spec went stale makes this spec stale too. The first problem found wins;
 * a healthy spec answers "ready".
 */
export async function specStatus(
  spec: TransformSpecLike,
  resolve: DatasetResolver,
): Promise<HealthReport> {
  return statusOfSpec(spec, resolve, new Set<string>());
}

/** One referenced read the health walk checks: the id plus what columns to compare (lookup reads) or nothing (existence-only). */
interface CollectedRead {
  fields: string[] | undefined;
  id: string;
  lookupKey: string[];
}

/** One lookup operation's read, keyed columns included. */
function collectLookupRead(operation: Record<string, unknown>, baseKeys: string[]): CollectedRead {
  if (typeof operation.baseKey === "string" && !baseKeys.includes(operation.baseKey)) {
    baseKeys.push(operation.baseKey);
  }
  return {
    fields: stringArrayOrUndefined(operation.fields),
    id: typeof operation.lookupDatasetId === "string" ? operation.lookupDatasetId : "",
    lookupKey: typeof operation.lookupKey === "string" ? [operation.lookupKey] : [],
  };
}

/** One sql operation's table refs as existence-only reads: the query TEXT is opaque to a structural walk, a vanished dataset is not. */
function collectSqlReads(operation: Record<string, unknown>): CollectedRead[] {
  if (!Array.isArray(operation.tables)) {
    return [];
  }
  const reads: CollectedRead[] = [];
  for (const table of operation.tables) {
    if (isRecord(table)) {
      reads.push({
        fields: undefined,
        id: typeof table.datasetId === "string" ? table.datasetId : "",
        lookupKey: [],
      });
    }
  }
  return reads;
}

/** The reads a spec makes, collected for the health walk: the source's `baseKey`s plus each operation's references. */
function collectReads(spec: TransformSpecLike): {
  baseKeys: string[];
  lookups: CollectedRead[];
} {
  const baseKeys: string[] = [],
    lookups: CollectedRead[] = [];
  if (!Array.isArray(spec.operations)) {
    return { baseKeys, lookups };
  }
  for (const operation of spec.operations) {
    if (!isRecord(operation)) {
      continue;
    }
    if (operation.kind === "lookup") {
      lookups.push(collectLookupRead(operation, baseKeys));
      continue;
    }
    if (operation.kind === "sql") {
      lookups.push(...collectSqlReads(operation));
    }
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

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** The registry row wire shape — camelCase aliases over the `derived_datasets` columns (DDL §3.5). */
export interface DerivedDatasetRow {
  id: string;
  /** Only required field (the ui-polish rule; `save` trims and refuses blanks). */
  title: string;
  description: string | null;
  /** The serializable TransformSpec, stored shapeless — validated structurally, never narrowed. */
  spec: unknown;
  /** The source dataset (a base dataset) when the spec reads one. */
  sourceDatasetId: string | null;
  /** The source registry row (derived-of-derived) when the spec reads one. Exactly one of the two is set (the num_nonnulls check). */
  sourceDerivedId: string | null;
  /** Denormalized edges for the save-time cycle walk — `specDependencies`' output at save time. */
  dependsOn: string[];
  status: "draft" | "saved";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** The list/badge projection: everything a row list renders, health included (the Convex `summaryValidator` shape, PG ids/timestamps). */
export interface DerivedDatasetSummaryRow {
  id: string;
  title: string;
  description: string | null;
  /** Whether the stored spec carries a sql operation — the Analyze tab's list filter (computed HERE so the projection stays light). */
  carriesSql: boolean;
  createdBy: string;
  createdAt: string;
  /** The row's source id — whichever of the two source columns is set (the Convex summary's single string field). */
  sourceDatasetId: string;
  status: "draft" | "saved";
  health: DerivedHealth;
  healthReason?: string;
}

/** A full row with its read-time health — the builder's `get` (the Convex `docValidator` + health shape). */
export interface DerivedDatasetWithHealth extends DerivedDatasetRow {
  health: DerivedHealth;
  healthReason?: string;
}

const DERIVED_FULL_SELECT =
  "id,title,description,spec,sourceDatasetId:source_dataset_id,sourceDerivedId:source_derived_id,dependsOn:depends_on,status,createdBy:created_by,createdAt:created_at,updatedAt:updated_at";

/** PG ids are uuids; every id this module interpolates into an `or()` filter string is shape-checked first (the entries.ts cursor-injection guard: a quoted PostgREST filter value is built from validated uuids only). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row's source id — whichever source column is set (exactly one is, per the DDL check). */
export function sourceIdOf(row: DerivedDatasetRow): string {
  if (row.sourceDatasetId !== null) {
    return row.sourceDatasetId;
  }
  if (row.sourceDerivedId !== null) {
    return row.sourceDerivedId;
  }
  throw new Error(
    `Derived dataset ${row.id} has no source (the DDL check should make this impossible).`,
  );
}

/** Whether the stored spec carries a sql operation — the analysis registry read's filter (the Convex `specCarriesSql`, copied). */
export function specCarriesSql(spec: unknown): boolean {
  if (!isRecord(spec) || !Array.isArray(spec.operations)) {
    return false;
  }
  return spec.operations.some((operation) => isRecord(operation) && operation.kind === "sql");
}

function derivedRowOf(wire: DerivedDatasetRow): DerivedDatasetRow {
  return {
    createdAt: wire.createdAt,
    createdBy: wire.createdBy,
    dependsOn: wire.dependsOn ?? [],
    description: wire.description,
    id: wire.id,
    sourceDatasetId: wire.sourceDatasetId,
    sourceDerivedId: wire.sourceDerivedId,
    spec: wire.spec,
    status: wire.status,
    title: wire.title,
    updatedAt: wire.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The PG resolver — the health walk's view of a referenced dataset
// ---------------------------------------------------------------------------

/**
 * Resolves one referenced dataset id for the walks: a registry row
 * (derived-of-derived edges), a base dataset's declared structure, or
 * nothing. Both legs are plain RLS-scoped reads — a foreign draft (either
 * kind) resolves as missing, which is exactly the Convex stage-8 read
 * ("another user's autosave reads exactly as a missing row"). Non-uuid ids
 * skip the queries (PG has no string id space to probe). The `cache` is the
 * per-call memo (issue #128): one shared Map makes the reads proportional
 * to DISTINCT ids, not rows.
 */
function pgDatasetResolver(
  client: SupabaseClient,
  cache: Map<string, ReferencedDataset>,
): DatasetResolver {
  return async (id) => {
    const hit = cache.get(id);
    if (hit !== undefined) {
      return hit;
    }
    const resolved = await resolveDatasetUncached(client, id);
    cache.set(id, resolved);
    return resolved;
  };
}

async function resolveDatasetUncached(
  client: SupabaseClient,
  id: string,
): Promise<ReferencedDataset> {
  if (!UUID_RE.test(id)) {
    return { kind: "missing" };
  }
  const registryRow = await queryRow<{ spec: unknown; title: string }>(
    client.from("derived_datasets").select("spec,title").eq("id", id).limit(1),
  );
  if (registryRow !== null) {
    return { kind: "registry", spec: registryRow.spec, title: registryRow.title };
  }
  const dataset = await queryRow<{ properties: string[] | null; title: string }>(
    client.from("datasets").select("properties,title").eq("id", id).limit(1),
  );
  if (dataset !== null) {
    return {
      kind: "component",
      properties: dataset.properties ?? [],
      title: dataset.title,
    };
  }
  return { kind: "missing" };
}

/** The health of one row, computed over a shared resolver memo (the caller builds the memo per read). */
async function healthOf(
  client: SupabaseClient,
  cache: Map<string, ReferencedDataset>,
  spec: unknown,
): Promise<HealthReport> {
  return specStatus(asSpec(spec), pgDatasetResolver(client, cache));
}

/** Maps wire rows to the summary projection, health computed per row over ONE shared memo. */
async function summariesOf(
  client: SupabaseClient,
  wireRows: DerivedDatasetRow[],
): Promise<DerivedDatasetSummaryRow[]> {
  const cache = new Map<string, ReferencedDataset>();
  return await Promise.all(
    wireRows.map(async (wire) => {
      const row = derivedRowOf(wire);
      const health = await healthOf(client, cache, row.spec);
      return {
        carriesSql: specCarriesSql(row.spec),
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        description: row.description,
        health: health.health,
        healthReason: health.reason,
        id: row.id,
        sourceDatasetId: sourceIdOf(row),
        status: row.status,
        title: row.title,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Reads (TanStack Query `queryOptions` per function, design §8.1)
// ---------------------------------------------------------------------------

/** Upper bound per read of `listBySource` — the same documented bound the Convex read always had (derivedDatasets.ts:343). */
export const LIST_BY_SOURCE_MAX = 200;

/** The catalog projection's bound — the Convex `summaries` take(500) (derivedDatasets.ts:429; past it the projection must gain pagination). */
export const SUMMARIES_READ_LIMIT = 500;

/**
 * Every registry row targeting one source dataset, newest first — the
 * Transform tab's list (specs authored over THIS dataset). One RLS-scoped
 * read replaces the Convex two-leg merge: the database hands back exactly
 * the saved rows over this source plus the caller's own rows (drafts
 * included), which is the union the two legs served — and a foreign draft
 * can no longer push visible rows out of the take window (issue #128's
 * concern, answered by the 0010 policies instead of index legs). Bounded at
 * LIST_BY_SOURCE_MAX; health runs over one shared resolution memo.
 */
export function listBySourceQueryOptions(
  args: { sourceDatasetId: string },
  options?: StoreOptions,
) {
  return queryOptions({
    queryKey: ["pg:derived", "listBySource", args],
    queryFn: async (): Promise<DerivedDatasetSummaryRow[]> => {
      // A non-uuid names nothing in the PG id space — the empty answer the
      // Convex index lookup gave junk ids, without the junk reaching the
      // filter string.
      if (!UUID_RE.test(args.sourceDatasetId)) {
        return [];
      }
      const client = clientOf(options);
      const rows = await queryRows<DerivedDatasetRow>(
        client
          .from("derived_datasets")
          .select(DERIVED_FULL_SELECT)
          .or(
            `source_dataset_id.eq.${args.sourceDatasetId},source_derived_id.eq.${args.sourceDatasetId}`,
          )
          .order("created_at", { ascending: false })
          .limit(LIST_BY_SOURCE_MAX),
      );
      return await summariesOf(client, rows);
    },
  });
}

/**
 * The catalog projection — the datasets browser's derived cards. SAVED rows
 * only: an 800ms-debounced autosave must never surface in the catalog as a
 * finished derived dataset (the `.eq("status", "saved")` filter is
 * load-bearing even though RLS would admit the caller's own drafts — the
 * datasets.ts listSummaries draft-filter rule, applied to this registry).
 * Bounded well below catalog scale (SUMMARIES_READ_LIMIT).
 */
export function summariesQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:derived", "summaries", SUMMARIES_READ_LIMIT],
    queryFn: async (): Promise<DerivedDatasetSummaryRow[]> => {
      const client = clientOf(options);
      const rows = await queryRows<DerivedDatasetRow>(
        client
          .from("derived_datasets")
          .select(DERIVED_FULL_SELECT)
          .eq("status", "saved")
          .order("created_at", { ascending: false })
          .limit(SUMMARIES_READ_LIMIT),
      );
      return await summariesOf(client, rows);
    },
  });
}

/**
 * One full registry row by id, health included; null when RLS hides it
 * (unknown, deleted, or another user's draft — the same "reads as missing"
 * answer the Convex `get` gave creator-scoped drafts). Saved rows stay
 * catalog-visible: a saved spec's shape is readable like any published
 * dataset's page.
 */
export function getQueryOptions(args: { id: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:derived", "get", args],
    queryFn: async (): Promise<DerivedDatasetWithHealth | null> => {
      const client = clientOf(options);
      const wire = await queryRow<DerivedDatasetRow>(
        client.from("derived_datasets").select(DERIVED_FULL_SELECT).eq("id", args.id).limit(1),
      );
      if (wire === null) {
        return null;
      }
      const row = derivedRowOf(wire);
      const health = await healthOf(client, new Map<string, ReferencedDataset>(), row.spec);
      return { ...row, health: health.health, healthReason: health.reason };
    },
  });
}

// ---------------------------------------------------------------------------
// Writes (plain functions; features wrap them in useMutation + invalidation)
// ---------------------------------------------------------------------------

/** The builder's save argument set — the Convex `save` mutation's args, minus `id`'s presence distinction being the insert/update split. */
export interface SaveDerivedDatasetArgs {
  /** Present when patching an existing row (the client keeps the id the first autosave minted); absent for a brand-new transform. */
  id?: string;
  title: string;
  description?: string;
  /** The serializable TransformSpec — validated structurally, stored shapeless. */
  spec: unknown;
  status: "draft" | "saved";
}

/** The source id resolves to neither a visible registry row nor a visible dataset — the save refuses (the FK on both source columns would reject the insert anyway; the message is the save's authoring-boundary shape). */
const SOURCE_ACCESS_ERROR =
  "That dataset or transform doesn't exist or you don't have access to it.";

/**
 * A dependency id resolves to nothing the author can read — the save refuses
 * (the authoring-boundary gate below). RLS cannot tell WHICH table hides an
 * id (a foreign draft of either kind reads exactly as a missing row), so the
 * copy names both — the Convex save's table-flavored pair, collapsed into
 * what the database will honestly say.
 */
const DEPENDENCY_ACCESS_ERROR =
  "A dataset or transform this spec reads doesn't exist or you don't have access to it.";

interface SourceLegs {
  sourceDatasetId: string | null;
  sourceDerivedId: string | null;
}

/**
 * Classifies the spec's `sourceDatasetId` into the DDL's two source columns:
 * a visible registry row files under `source_derived_id` (derived-of-derived),
 * anything else visible under `source_dataset_id`. A foreign draft resolves
 * as missing on both legs (RLS) and refuses here — the Convex save's
 * explicit authoring-boundary refusal (assertSpecDependenciesVisible's
 * registry leg), enforced by invisibility + the FKs instead of a privileged
 * read. (The refusal copy is table-neutral — see DEPENDENCY_ACCESS_ERROR: an
 * RLS-scoped store cannot tell a foreign-draft transform from a foreign-draft
 * dataset, which is exactly the privacy the row-level security buys; the
 * Convex messages split only because its mutations read every row.)
 */
async function sourceLegsOf(client: SupabaseClient, sourceDatasetId: string): Promise<SourceLegs> {
  if (!UUID_RE.test(sourceDatasetId)) {
    throw new Error(SOURCE_ACCESS_ERROR);
  }
  const derived = await queryRow<{ id: string }>(
    client.from("derived_datasets").select("id").eq("id", sourceDatasetId).limit(1),
  );
  if (derived !== null) {
    return { sourceDatasetId: null, sourceDerivedId: sourceDatasetId };
  }
  const dataset = await queryRow<{ id: string }>(
    client.from("datasets").select("id").eq("id", sourceDatasetId).limit(1),
  );
  if (dataset !== null) {
    return { sourceDatasetId: sourceDatasetId, sourceDerivedId: null };
  }
  throw new Error(SOURCE_ACCESS_ERROR);
}

/** The cycle walk's registry-row lookup over the persisted edges (RLS-scoped: a foreign draft stops the walk, exactly as a missing row would — the walk can only continue through rows the walker may read). */
function registryRowLookupOf(client: SupabaseClient) {
  return async (id: string): Promise<RegistryRowLike | null> => {
    if (!UUID_RE.test(id)) {
      return null;
    }
    const row = await queryRow<{ dependsOn: string[] | null }>(
      client.from("derived_datasets").select("dependsOn:depends_on").eq("id", id).limit(1),
    );
    if (row === null) {
      return null;
    }
    return { dependsOn: row.dependsOn ?? [] };
  };
}

/**
 * The save gate's dependency leg (derivedDatasets.ts:208-239,
 * assertSpecDependenciesVisible, PG edition): every dataset a spec reads —
 * its source and each operation's lookup dataset / SQL table ref, exactly
 * `specDependencies`' walk — must be VISIBLE to the author before the save
 * may reference it. A spec authored over an invisible id would mint
 * catalog-visible registry rows (and, once saved, consumer_references
 * edges) naming data the author cannot read; it would also let the
 * cross-user cycle hole reopen — a foreign draft B' over this author's saved
 * row is invisible to the cycle walk's RLS-scoped lookup, so a lookup dep
 * naming B' would persist an edge that closes into a cycle the moment B'
 * saves (the tranche-3 finding). The walk reads RLS-scoped: an invisible
 * dependency of EITHER kind refuses the save. Deps the row already
 * persists are tolerated (a spec whose referenced dataset was deleted stays
 * editable — it re-reads as orphaned by the health walk, never blocked;
 * the Convex unknown-id tolerance, applied to the persisted edges since an
 * RLS-scoped read cannot distinguish a deleted id from a foreign draft).
 * Non-uuid ids skip the queries (the health system's domain, as on Convex).
 */
async function assertNewDependenciesVisible(
  client: SupabaseClient,
  persistedDeps: ReadonlySet<string>,
  dependencies: string[],
  sourceDatasetId: string,
): Promise<void> {
  // The SOURCE id is skipped — sourceLegsOf classifies it right after (its
  // refusal is the save's authoring-boundary message), so the gate probes
  // only the operation's lookup/sql-table dependencies.
  const fresh = [...new Set(dependencies)].filter(
    (id) => !persistedDeps.has(id) && UUID_RE.test(id) && id !== sourceDatasetId,
  );
  await Promise.all(
    fresh.map(async (id) => {
      const visible =
        (await queryRow<{ id: string }>(
          client.from("derived_datasets").select("id").eq("id", id).limit(1),
        )) !== null ||
        (await queryRow<{ id: string }>(
          client.from("datasets").select("id").eq("id", id).limit(1),
        )) !== null;
      if (!visible) {
        throw new Error(DEPENDENCY_ACCESS_ERROR);
      }
    }),
  );
}

/**
 * The saved spec's reference edges (derivedDatasets.ts:330-340 +
 * consumption.ts:1429, syncRegistryReferenceEdges — the stage-7 parity fix
 * for the recorded PG gap): one `consumer_references` row per dependency,
 * surviving edges keep their mode, new edges land float, removed edges' rows
 * go. SAVED writers only (the save path gates it — builder autosaves never
 * surface as consumers), and the caller runs it on the same client so the
 * edges stay as close to the save's commit as the two statements allow.
 * Deltas against the Convex helper, both forced by the PG DDL: edges exist
 * only for DATASET dependencies (consumer_references.source_dataset_id has
 * an FK to datasets — a derived-of-derived edge is unrepresentable; the
 * depends_on edges carry that relation), and only uuid-shaped deps are
 * written (the FK makes anything else unrepresentable too).
 */
async function syncConsumerReferenceEdges(
  client: SupabaseClient,
  registryId: string,
  dependencies: string[],
): Promise<void> {
  const existing = await queryRows<{ id: string; sourceDatasetId: string | null }>(
    client
      .from("consumer_references")
      .select("id,sourceDatasetId:source_dataset_id")
      .eq("consumer_id", registryId)
      .eq("consumer_kind", "derived"),
  );
  // Only deps that resolve to a visible DATASET get edges (the FK limits
  // source_dataset_id to datasets; registry-row deps are skipped here, not
  // error'd — the FK would throw 23503 past RLS's 0-rows shape).
  const datasetDeps = await Promise.all(
    [...new Set(dependencies)].map(async (dependency) => {
      if (!UUID_RE.test(dependency)) {
        return null;
      }
      const dataset = await queryRow<{ id: string }>(
        client.from("datasets").select("id").eq("id", dependency).limit(1),
      );
      return dataset === null ? null : dependency;
    }),
  );
  for (const dependency of datasetDeps) {
    if (dependency === null) {
      continue;
    }
    if (existing.some((ref) => ref.sourceDatasetId === dependency)) {
      continue;
    }
    // One edge per dependency, ordered like the spec's own walk.
    // oxlint-disable-next-line no-await-in-loop -- the edge set must land in the spec's dependency order.
    await queryRows<{ id: string }>(
      client
        .from("consumer_references")
        .insert({
          consumer_id: registryId,
          consumer_kind: "derived",
          mode: "float",
          source_dataset_id: dependency,
        })
        .select("id"),
    );
  }
  for (const ref of existing) {
    if (!dependencies.includes(ref.sourceDatasetId ?? "")) {
      // oxlint-disable-next-line no-await-in-loop -- see above; the edge set must leave in the same order.
      await queryRows<{ id: string }>(
        client.from("consumer_references").delete().eq("id", ref.id).select("id"),
      );
    }
  }
}

/**
 * The save's validated inputs, or a thrown gate error — the Convex `save`'s
 * first three gates, in its order: title required (trimmed), blank
 * descriptions refused, structural spec validation. Extracted so `save`
 * stays a thin two-path writer.
 */
function validatedInputsOf(args: SaveDerivedDatasetArgs): {
  dependencies: string[];
  description: string | null;
  sourceDatasetId: string;
  spec: unknown;
  title: string;
} {
  const title = args.title.trim();
  if (title === "") {
    throw new Error("Give the transform a title.");
  }
  if (args.description !== undefined && args.description.trim() === "") {
    throw new Error("Leave the description empty instead of blank.");
  }
  const validated = validateSpecShape(args.spec);
  if (!validated.ok) {
    throw new Error(validated.reason);
  }
  return {
    dependencies: specDependencies(validated.spec),
    description: args.description ?? null,
    sourceDatasetId: validated.spec.sourceDatasetId,
    spec: args.spec,
    title,
  };
}

/** The insert/update payload shared by both save paths — the source columns stay in lockstep with the spec. */
function savePayloadOf(
  legs: SourceLegs,
  inputs: ReturnType<typeof validatedInputsOf>,
  status: "draft" | "saved",
): Record<string, unknown> {
  return {
    depends_on: inputs.dependencies,
    description: inputs.description,
    source_dataset_id: legs.sourceDatasetId,
    source_derived_id: legs.sourceDerivedId,
    spec: inputs.spec,
    status,
    title: inputs.title,
  };
}

/**
 * Creates or updates one registry row — the builder's autosave (status
 * "draft") and its explicit Save (status "saved") both land here. Returns
 * the row id, which the client keeps for subsequent autosaves.
 *
 * Mirrors the Convex `save` step for step: the gates (title, description,
 * spec shape), dependencies denormalized into `depends_on`, cycle rejection
 * on updates only, and the source columns kept in lockstep with
 * `spec.sourceDatasetId`. The update path refuses a foreign SAVED row
 * (RLS-visible but not the creator — the 0-row answer reads as the Convex
 * access denial, never as success).
 */
export async function save(args: SaveDerivedDatasetArgs, options?: StoreOptions): Promise<string> {
  const client = clientOf(options);
  const inputs = validatedInputsOf(args);

  if (args.id !== undefined) {
    const existing = await queryRow<DerivedDatasetRow>(
      client.from("derived_datasets").select(DERIVED_FULL_SELECT).eq("id", args.id).limit(1),
    );
    if (existing === null) {
      throw new Error("This transform no longer exists — it may have been deleted.");
    }
    const cycle = await findCycleToOrigin(
      args.id,
      inputs.dependencies,
      registryRowLookupOf(client),
    );
    if (cycle !== undefined) {
      throw new Error(
        "Saving this transform would create a circular dependency — it reads from a dataset that (through other derived datasets) reads from this one.",
      );
    }
    // The authoring-boundary gate (assertNewDependenciesVisible) runs on the
    // FRESH deps only — deps the row already persists are tolerated (they
    // re-read as orphaned; refusing the save would strand the author with an
    // uneditable stale spec).
    await assertNewDependenciesVisible(
      client,
      new Set<string>(existing.dependsOn ?? []),
      inputs.dependencies,
      inputs.sourceDatasetId,
    );
    const legs = await sourceLegsOf(client, inputs.sourceDatasetId);
    const rows = await queryRows<{ id: string }>(
      client
        .from("derived_datasets")
        .update(savePayloadOf(legs, inputs, args.status))
        .eq("id", args.id)
        .select("id"),
    );
    if (rows.length === 0) {
      // RLS-visible (a foreign SAVED row) but not the creator — the update
      // policy filtered it. Same denial shape as a concurrent delete; the
      // message is the Convex save's.
      throw new Error("That transform doesn't exist or you don't have access to it.");
    }
    // The saved spec's reference edges (stage-7 parity fix): SAVED writers
    // only — a saved→draft flip leaves the old edges, exactly the Convex
    // helper's early return.
    if (args.status === "saved") {
      await syncConsumerReferenceEdges(client, args.id, inputs.dependencies);
    }
    return args.id;
  }

  await assertNewDependenciesVisible(
    client,
    new Set<string>(),
    inputs.dependencies,
    inputs.sourceDatasetId,
  );
  const legs = await sourceLegsOf(client, inputs.sourceDatasetId);
  const row = await queryRow<{ id: string }>(
    client
      .from("derived_datasets")
      .insert(savePayloadOf(legs, inputs, args.status))
      .select("id")
      .single(),
  );
  if (row === null) {
    throw new Error("Derived dataset insert returned no row.");
  }
  if (args.status === "saved") {
    await syncConsumerReferenceEdges(client, row.id, inputs.dependencies);
  }
  return row.id;
}

/**
 * Deletes one registry row — a discarded draft or an obsolete spec — and its
 * consumer_references edges (the stage-7 parity fix for the recorded PG gap:
 * a deleted row must not haunt its sources' consumed-by lists as a ghost
 * consumer; consumer_id is text with no FK, so the cascade cannot reach
 * them). Dependents (if any) re-read as orphaned on their next read.
 * Returns the affected row count: 0 = denied (not the creator — the 0010
 * delete policy) or already gone; the caller surfaces that, never toasts
 * success (the stage-4 silent-denial rule; the Convex `remove` threw the
 * equivalent denial).
 */
export async function remove(args: { id: string }, options?: StoreOptions): Promise<number> {
  const client = clientOf(options);
  // The edges go first (the Convex remove's order) — a denied delete leaves
  // the row intact and its edges untouched.
  await queryRows<{ id: string }>(
    client
      .from("consumer_references")
      .delete()
      .eq("consumer_id", args.id)
      .eq("consumer_kind", "derived")
      .select("id"),
  );
  const rows = await queryRows<{ id: string }>(
    client.from("derived_datasets").delete().eq("id", args.id).select("id"),
  );
  return rows.length;
}
