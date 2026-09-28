import { applyLookup } from "@caden/json-cms/react";
import type { LookupOperation } from "@caden/json-cms/react";
import type { ConvexReactClient } from "convex/react";

import { api } from "#convex/_generated/api";
import { fetchDatasetEntryRows, type DatasetEntryRow } from "#/lib/dataset-rows";

import type { Geometry } from "@caden/json-cms/react";

/**
 * Client-side export helpers shared by the dataset and group export
 * dialogs: GeoJSON / JSON payloads and Excel workbooks (via exceljs, the
 * same writer the xlsx import parser uses for reading), plus the "include
 * joined fields" enrichment step (roadmap 3a, #96; docs/derived-datasets-design.md
 * §8 lines 161-163): the saved transform specs targeting the exported
 * dataset run through the stage 1 engine (applyLookup, TransformPreview's
 * fold) and the namespaced columns simply ride `entry.data` into the
 * existing builders — none of them changes shape.
 */

/** Minimal entry shape the exporters need (Convex rows satisfy this). */
export interface ExportableEntry {
  _id: string;
  data: unknown;
  geometryId?: string;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(content: string, filename: string, type = "application/json"): void {
  downloadBlob(new Blob([content], { type }), filename);
}

/**
 * A GeoJSON FeatureCollection of `entries`: each entry's schema `data`
 * becomes the feature properties, and its geometry (when the entry has one)
 * rides along — entries without geometry export with `"geometry": null` so
 * row counts stay consistent with the other formats.
 *
 * `resolvedByGeometryRowId` is `useResolvedGeometries`' output, keyed by the
 * geometry row id — which is exactly what `entry.geometryId` points at.
 */
export function buildGeoJsonCollection(
  entries: ExportableEntry[],
  resolvedByGeometryRowId: globalThis.Map<string, Geometry>,
  schemaId: string,
): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    // Identifies which dataset's schema the properties conform to — useful
    // when a group export writes several collections side by side.
    id: schemaId,
    features: entries.map((entry) => ({
      type: "Feature",
      geometry: entry.geometryId ? (resolvedByGeometryRowId.get(entry.geometryId) ?? null) : null,
      properties: entry.data,
    })),
  };
}

/** The plain-JSON export payload — the same shape the existing export button produced. */
export function buildJsonPayload(
  schema: unknown,
  entries: ExportableEntry[],
): Record<string, unknown> {
  return {
    $schema: schema,
    entries: entries.map((entry) => entry.data),
  };
}

/** Objects/arrays can't sit in a cell — serialize them; nulls become empty. */
function cellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to primitives above (nullish and objects return early); cell values are strings or numbers by construction.
  return value as string | number;
}

/** Excel sheet names: max 31 chars, no [:\\/?*[]], unique within a workbook. */
export function sanitizeSheetName(title: string, used: Set<string>): string {
  const base =
      title
        .replace(/[:\\/?*[\]]/g, " ")
        .trim()
        .slice(0, 31) || "Sheet",
    dedupe = (name: string) =>
      used.has(name) ? `${name.slice(0, 31 - 2)}-${used.size + 1}` : name,
    name = dedupe(base);
  used.add(name);
  return name;
}

/**
 * Normalizes entries into flat rows for an Excel worksheet: object data
 * spreads as-is (one column per property); a non-object entry degrades to a
 * single `value` column.
 */
export function entryRows(entries: ExportableEntry[]): Array<Record<string, unknown>> {
  return entries.map((entry) =>
    typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the typeof/Array guards above exclude null and arrays; entry data is a plain JSON object by construction.
        (entry.data as Record<string, unknown>)
      : { value: entry.data },
  );
}

/**
 * Writes one Excel workbook and triggers its download. `sheets` maps
 * 1:1 to worksheets; columns are the union of each sheet's row keys in
 * first-seen order.
 */
export async function exportExcelWorkbook(
  sheets: { name: string; rows: Array<Record<string, unknown>> }[],
  filename: string,
): Promise<void> {
  const ExcelJS = await import("exceljs"),
    workbook = new ExcelJS.Workbook(),
    used = new Set<string>();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name, used)),
      columns: string[] = [];
    for (const row of sheet.rows) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) {
          columns.push(key);
        }
      }
    }
    worksheet.columns = columns.map((column) => ({ header: column, key: column }));
    worksheet.addRows(
      sheet.rows.map((row) => Object.fromEntries(columns.map((c) => [c, cellValue(row[c])]))),
    );
  }
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename,
  );
}

// ---------------------------------------------------------------------------
// "Include joined fields" (roadmap 3a, #96; ADR 0005 §10.3)
//
// The recorded export semantics, so the dialogs stay consistent with the
// engine and the registry rather than inventing their own:
//
// - **Field selection is AS STORED** (§11 lines 233-234 leave the default
//   open; spec.ts:46-54 fixed the engine's half): an operation with picked
//   `fields` brings exactly those, in order; a spec whose fields were left
//   omitted ("all" in the builder) brings the engine's omit-means-all union
//   — every lookup field except the join key, first-seen across the table.
// - **Several saved specs over one dataset apply ALL, as one fold** — this
//   module's decision for the issue's open multi-spec question. Each spec is
//   an independent enrichment view its author saved over this dataset, and
//   folding all of them is the superset of "the dataset's joined fields";
//   order is the caller's (the dialogs pass `listBySource` order, newest
//   first, which is also the Transform tab's display order). Where two specs
//   share a namespace, the later fold's enrichment wins — the engine's own
//   "enrichment beats a pre-existing same-named key" invariant
//   (lookup.ts:32-36), so the outcome is defined, not accidental.
// - **Unmatched rows survive with null enriched fields** (left join,
//   spec.ts:64-69) — or drop, only when a spec explicitly stored
//   `match: "inner"`, which drops those entries from the export like the
//   engine drops the rows.
// - The OFF path must never touch this module: applyLookup always allocates
//   fresh rows (lookup.ts:213,224), so only skipping it keeps an untoggled
//   export byte-identical to today's.
// ---------------------------------------------------------------------------

/**
 * One saved spec, read structurally — the registry's `TransformSpecLike`
 * pattern (derivedSpec.ts:35-38): specs are stored shapeless (`v.any()`, the
 * additive-storage rule), so stage 4's new operation kinds must be skippable
 * here without a migration, never a crash.
 */
export interface ExportTransformSpec {
  readonly operations: readonly unknown[];
}

/**
 * The engine's records for each lookup side the specs read, keyed by dataset
 * id — built once per export by `loadLookupRows` so two specs (or two group
 * members) sharing a lookup dataset fetch it once.
 */
export type LookupRowsByDatasetId = ReadonlyMap<string, readonly Record<string, unknown>[]>;

/** Joins the enrichment onto the entry object via a symbol a data field can never collide with. */
const ENTRY_IDENTITY: unique symbol = Symbol("exportEntryIdentity");
/** Whether the tagged entry's original `data` was an object (rides the row through the engine's fresh-row copies — positional indexing desyncs the moment an inner join drops a row). */
const ENTRY_HAD_OBJECT_DATA: unique symbol = Symbol("exportEntryHadObjectData");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entry's `data` as the engine's generic record — `undefined` when the entry carries no object. */
function dataRecordOf(data: unknown): Record<string, unknown> | undefined {
  return isRecord(data) ? data : undefined;
}

/**
 * The lookup rows for every dataset the given specs read, streamed through
 * the row-resolution seam (`fetchDatasetEntryRows` — no bespoke pagination)
 * and keyed for the fold. Datasets whose rows can't be object-shaped simply
 * contribute nothing (a spec joined onto non-object entries is a no-op, not
 * an error).
 */
export async function loadLookupRows(
  lookupDatasetIds: readonly string[],
): Promise<LookupRowsByDatasetId> {
  const unique = [...new Set(lookupDatasetIds)],
    pairs = await Promise.all(
      unique.map(async (datasetId) => {
        const rows = await fetchDatasetEntryRows(datasetId),
          records: Record<string, unknown>[] = [];
        for (const row of rows) {
          const record = dataRecordOf(row.data);
          if (record !== undefined) {
            records.push(record);
          }
        }
        return [datasetId, records] as const;
      }),
    );
  return new globalThis.Map(pairs);
}

/** The lookup dataset ids a set of specs reads (their operations' sides), first-seen, distinct. */
export function lookupDatasetIdsOf(specs: readonly ExportTransformSpec[]): string[] {
  const ids: string[] = [];
  for (const spec of specs) {
    for (const operation of spec.operations) {
      if (isRecord(operation) && operation.kind === "lookup") {
        const id = operation.lookupDatasetId;
        if (typeof id === "string" && id !== "" && !ids.includes(id)) {
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

/**
 * Loads the full registry docs for the given ready summaries (an export is a
 * one-shot read — imperative `get`s, not a standing subscription) and groups
 * their specs by source dataset id, ready for `enrichExportEntries`. Docs
 * that vanished between listing and read drop out; a doc whose stored spec
 * lost its operations array contributes an empty (no-op) spec rather than
 * throwing mid-export.
 */
export async function loadSpecsBySource(
  convex: ConvexReactClient,
  readySummaries: readonly { _id: string }[],
): Promise<globalThis.Map<string, ExportTransformSpec[]>> {
  const docs = await Promise.all(
    readySummaries.map(async (summary) => convex.query(api.derivedDatasets.get, { id: summary._id })),
  );
  const specsBySource = new globalThis.Map<string, ExportTransformSpec[]>();
  for (const doc of docs) {
    if (doc === null) {
      continue;
    }
    // The stored spec is shapeless by design (schema.ts v.any) — read it
    // structurally: a doc without an operations array contributes a no-op
    // spec rather than throwing mid-export.
    const stored = isRecord(doc.spec) ? doc.spec : {},
      operations = stored.operations,
      spec: ExportTransformSpec = { operations: Array.isArray(operations) ? operations : [] },
      existing = specsBySource.get(doc.sourceDatasetId);
    if (existing !== undefined) {
      existing.push(spec);
    } else {
      specsBySource.set(doc.sourceDatasetId, [spec]);
    }
  }
  return specsBySource;
}

/** The summary fields the enrichment step reads, read structurally off the registry projection. */
export interface TransformSummaryLike {
  _id: string;
  /** The read-time health literal ("orphaned" | "ready" | "stale"); only "ready" applies. */
  health: string;
  sourceDatasetId: string;
  /** The registry row's lifecycle status over its open literal union; only explicitly "saved" rows fold into exports (an autosaved draft must never). */
  status: string;
}

/**
 * The rows an export may apply: explicitly SAVED (the registry's recorded
 * rule — catalog consumers read saved rows; listBySource's drafts are the
 * Transform tab's business) whose read-time health is "ready" (the one
 * staleness signal, derivedSpec.specStatus). Status filters to the known
 * literal over the open union, so stage 5's additions never silently qualify.
 */
export function readyRowsOf(
  summaries: readonly TransformSummaryLike[] | undefined,
): TransformSummaryLike[] {
  return (summaries ?? []).filter((row) => row.status === "saved" && row.health === "ready");
}

/**
 * The toggled export's enrichment step, shared by both dialogs: keeps only
 * the ready saved summaries (see `readyRowsOf`), loads their spec docs, folds
 * each source dataset's specs onto that source's rows in place, and returns
 * how many listed transforms were skipped for not qualifying (the success
 * toast reports it). Throws on a spec whose duplicate-key policy rejects the
 * data (`LookupKeyConflictError`) — callers turn that into the error toast
 * and abort the export.
 */
export async function applyJoinedFields(
  convex: ConvexReactClient,
  listedSummaries: readonly TransformSummaryLike[] | undefined,
  rowsBySource: globalThis.Map<string, DatasetEntryRow[]>,
): Promise<number> {
  const ready = readyRowsOf(listedSummaries),
    specsBySource = await loadSpecsBySource(
      convex,
      ready.map((row) => ({ _id: row._id })),
    ),
    lookupRows = await loadLookupRows(lookupDatasetIdsOf([...specsBySource.values()].flat()));
  for (const [sourceId, specs] of specsBySource) {
    const rows = rowsBySource.get(sourceId);
    if (rows !== undefined) {
      rowsBySource.set(sourceId, enrichExportEntries(rows, specs, lookupRows));
    }
  }
  return (listedSummaries ?? []).length - ready.length;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((field) => typeof field === "string");
}

/** A required lookup column, verified present and non-empty (the save gate's `lookupColumnsError` shape). */
function requiredColumnError(operation: Record<string, unknown>, column: string): boolean {
  const cell = operation[column];
  return typeof cell !== "string" || cell === "";
}

/** The optional cells' parsed values, or `undefined` when one is out of shape. */
interface LookupOptions {
  fields?: string[];
  match?: "inner" | "left";
  namespace?: string;
  onDuplicateKey?: "error" | "first" | "last";
}

/** The fields/namespace cells, read into `options` — false when one is out of shape. */
function scalarOptionsOf(operation: Record<string, unknown>, options: LookupOptions): boolean {
  if (operation.fields !== undefined) {
    if (!isStringArray(operation.fields)) {
      return false;
    }
    options.fields = operation.fields;
  }
  if (operation.namespace !== undefined) {
    if (typeof operation.namespace !== "string") {
      return false;
    }
    options.namespace = operation.namespace;
  }
  return true;
}

/** The match/onDuplicateKey cells, read into `options` — false when one is out of shape. */
function policyOptionsOf(operation: Record<string, unknown>, options: LookupOptions): boolean {
  if (operation.match !== undefined) {
    if (operation.match !== "left" && operation.match !== "inner") {
      return false;
    }
    options.match = operation.match;
  }
  if (operation.onDuplicateKey !== undefined) {
    if (
      operation.onDuplicateKey !== "error" &&
      operation.onDuplicateKey !== "first" &&
      operation.onDuplicateKey !== "last"
    ) {
      return false;
    }
    options.onDuplicateKey = operation.onDuplicateKey;
  }
  return true;
}

/** Reads the four optional cells (fields/namespace/match/onDuplicateKey) — each tolerated only in the shape the engine defines; anything else skips the whole operation. */
function operationOptionsOf(operation: Record<string, unknown>): LookupOptions | undefined {
  const options: LookupOptions = {};
  if (!scalarOptionsOf(operation, options) || !policyOptionsOf(operation, options)) {
    return undefined;
  }
  return options;
}

/**
 * One operation record as the engine's `LookupOperation`, or `undefined` when
 * it isn't one the engine can run — the structural read's narrowing. A
 * required column missing or an optional cell of the wrong shape skips the
 * operation (a malformed stored spec must degrade, never crash an export);
 * `validateSpecShape` already rejects these at save time (derivedSpec.ts).
 */
function lookupOperationOf(operation: Record<string, unknown>): LookupOperation | undefined {
  const baseKey = operation.baseKey,
    lookupDatasetId = operation.lookupDatasetId,
    lookupKey = operation.lookupKey,
    requiredMalformed =
      requiredColumnError(operation, "baseKey") ||
      requiredColumnError(operation, "lookupDatasetId") ||
      requiredColumnError(operation, "lookupKey") ||
      typeof baseKey !== "string" ||
      typeof lookupDatasetId !== "string" ||
      typeof lookupKey !== "string";
  if (requiredMalformed) {
    return undefined;
  }
  const options = operationOptionsOf(operation);
  if (options === undefined) {
    return undefined;
  }
  return {
    baseKey,
    kind: "lookup",
    lookupDatasetId,
    lookupKey,
    ...options,
  };
}

/**
 * One spec's fold over the current entries: every object-shaped `entry.data`
 * is tagged with its entry behind a symbol (spread-safe identity — the
 * engine builds output columns from the lookup rows' keys only), pushed
 * through `applyLookup` once per lookup operation, and rebuilt into fresh
 * entries whose `data` carries the namespaced enrichment. Entries whose data
 * isn't an object ride along untouched (they have no key cells to join on);
 * `match: "inner"` drops the entries it drops in the engine.
 */
function applySpec<T extends ExportableEntry>(
  entries: readonly T[],
  spec: ExportTransformSpec,
  lookupRowsByDatasetId: LookupRowsByDatasetId,
): T[] {
  // The tags ride symbol keys so a data field can never collide with them;
  // object spreads carry symbols through, which is what keeps the identity
  // AND the object-data flag intact across the engine's fresh-row outputs —
  // positional bookkeeping would desync the moment an inner join drops a row.
  type TaggedRow = Record<string, unknown> & {
    [ENTRY_HAD_OBJECT_DATA]: boolean;
    [ENTRY_IDENTITY]: T;
  };
  const tagged: TaggedRow[] = [];
  for (const entry of entries) {
    const record = dataRecordOf(entry.data);
    tagged.push({
      ...record,
      [ENTRY_HAD_OBJECT_DATA]: record !== undefined,
      [ENTRY_IDENTITY]: entry,
    });
  }
  let rows: readonly TaggedRow[] = tagged;
  for (const operation of spec.operations) {
    // Stage 4+ operation kinds join additively (risk 10): unknown kinds skip
    // rather than crash — the export stays honest about what it CAN apply.
    if (!isRecord(operation) || operation.kind !== "lookup") {
      continue;
    }
    const parsed = lookupOperationOf(operation);
    if (parsed === undefined) {
      continue;
    }
    const sideRows = lookupRowsByDatasetId.get(parsed.lookupDatasetId);
    if (sideRows === undefined) {
      continue;
    }
    rows = applyLookup(parsed, rows, sideRows).rows;
  }
  // Rebuilt in a loop, not a map callback (the map-spread rule): each entry
  // object is fresh either way — applyLookup never returns an input row.
  const out: T[] = [];
  for (const row of rows) {
    const entry = row[ENTRY_IDENTITY];
    if (!row[ENTRY_HAD_OBJECT_DATA]) {
      out.push(entry);
      continue;
    }
    // Rest-destructure the tags out of a fresh copy — object spread carries
    // the symbol keys through the engine's own row copies, so stripping them
    // once, here, is all the output needs.
    const {
      [ENTRY_HAD_OBJECT_DATA]: _hadObjectData,
      [ENTRY_IDENTITY]: _tag,
      ...enriched
    } = row;
    out.push({ ...entry, data: enriched });
  }
  return out;
}

/**
 * Folds every given spec over `entries`' `data` records (see the block
 * comment above for the recorded semantics) and returns fresh entries whose
 * `data` gained the namespaced joined fields. `geometryId` and every other
 * entry field ride along untouched, so all four export builders —
 * `buildGeoJsonCollection`, `buildJsonPayload`, `entryRows`,
 * `exportExcelWorkbook` — pass enriched records straight through and the
 * namespaced columns simply appear.
 */
export function enrichExportEntries<T extends ExportableEntry>(
  entries: readonly T[],
  specs: readonly ExportTransformSpec[],
  lookupRowsByDatasetId: LookupRowsByDatasetId,
): T[] {
  let current = entries;
  for (const spec of specs) {
    current = applySpec(current, spec, lookupRowsByDatasetId);
  }
  return [...current];
}

