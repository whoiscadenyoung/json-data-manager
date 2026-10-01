/**
 * The publish orchestrator — the client half of the materialized publish
 * (roadmap 5b, #100; ADR 0008): execute the spec once, chunk, upload, and
 * freeze, over the host's publish-attempt checkpoint (the syncRuns pattern
 * for the window the sync engine never had).
 *
 * The boundary here is the roadmap's fixed one: spec execution is CLIENT-side
 * bulk compute (§2, ADR 0005) — this module runs in the browser from a
 * signed-in session, and there is deliberately NO server-side re-run path
 * (the component can't even host one: no Node runtime). What makes a killed
 * browser harmless is the host-side attempt: every uploaded chunk registers
 * on the attempt as it lands, so a resumed publish re-executes the
 * deterministic spec, skips the chunks already stored, and calls the freeze
 * once; after the freeze, durability is already the component workflow's.
 *
 * React-side consumers call `publishDataset`; the module shares the
 * imperative Convex client with the row-resolution seam and reuses its
 * pagination (entries for rows, geometries for payloads) rather than driving
 * any pagination of its own. Chunking is `chunkRowsForImport` — the exact
 * producer the import path documents.
 */
import { chunkRowsForImport, inferSchemaFromData } from "@caden/json-cms/react";
import type { ImportRow } from "@caden/json-cms/react";
import {
  declaredColumnTypes,
  geometrySourceOperationOf,
  transformSpecDependencies,
} from "@caden/json-cms/transform";
import type { GeometrySource, SqlColumnSpec, TransformSpec } from "@caden/json-cms/transform";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";

import { api } from "#convex/_generated/api";

import { MAX_ANALYSIS_RESULT_ROWS } from "./analysis-caps";
import { analysisSqlEngine } from "./analysis-duckdb";
import {
  entryDataRecord,
  fetchDatasetEntryRows,
  fetchDatasetGeometryRows,
  resolveGeometryRows,
  sharedClient,
} from "./dataset-rows";
import {
  executeSpecForPublish,
  geometryRuleOf,
  needsGeometryPlumbing,
  publishRecordOf,
  type PublishSourceTables,
} from "./publish-spec";

/** The attempt id type, as the start mutation mints it. */
type AttemptId = FunctionReturnType<typeof api.publish.start>["attemptId"];

/** What one publish run ended up as (status "importing" = handed off to the workflow). */
export interface PublishOutcome {
  attemptId: string;
  importId?: string;
  schemaId?: string;
  status: string;
}

/** The frozen-row plan a derived publish reports before uploading (a draft publish needs none — the host reads the draft at freeze). */
interface DerivedPlan {
  geometryType?: string;
  kind: "geospatial" | "standard";
  schema: Record<string, unknown>;
  spec: unknown;
}

function isRecordShaped(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One draft's rows as chunk rows: every entry, plus its geometry payload when the entry has one. */
async function draftChunkRows(convex: ConvexClient, datasetKey: string): Promise<ImportRow[]> {
  const entries = await fetchDatasetEntryRows(datasetKey, { convex, entryOrder: "asc" }),
    geometryPayloads = await resolveGeometryRows(
      await fetchDatasetGeometryRows(datasetKey, { convex }),
    );
  return entries.map((entry) => {
    const geometry =
      typeof entry.geometryId === "string" ? geometryPayloads.get(entry.geometryId) : undefined;
    return geometry === undefined
      ? { data: entryDataRecord(entry) }
      : { data: entryDataRecord(entry), geometry };
  });
}

/** Executes the target's rows: a saved transform's spec, or a draft's own entries. */
async function executeForPublish(
  convex: ConvexClient,
  datasetKind: "derived" | "draft",
  datasetKey: string,
): Promise<{ chunkRows: ImportRow[]; plan: DerivedPlan | undefined }> {
  if (datasetKind === "derived") {
    return derivedPublish(convex, datasetKey);
  }
  return { chunkRows: await draftChunkRows(convex, datasetKey), plan: undefined };
}

/** One derived row's chunk row, geometry payload inlined where resolved. */
function chunkRowsOfExecution(execution: {
  geometryPayloads: Array<unknown>;
  rows: Array<Record<string, unknown>>;
}): ImportRow[] {
  return execution.rows.map((data, index) => {
    const geometry = execution.geometryPayloads[index];
    return geometry === null || geometry === undefined ? { data } : { data, geometry };
  });
}

/**
 * Loads every dataset one spec reads: component datasets' rows (adapted with
 * the geometry pointer when the spec's rule names it) and geometries, plus
 * nested registry specs for derived-of-derived. Stage 9 (#105): each
 * component dataset's DECLARED structure loads alongside its rows
 * (`columnsByDatasetId`) so the sql engine's registration coerces exactly
 * like the interactive preview did — the declared typing, not row
 * inference, decides what a mixed-typed column folds into. Cycles can't
 * occur (the save gate rejects them); the has() guards are the defensive
 * stop.
 */
async function loadPublishTables(
  convex: ConvexClient,
  spec: unknown,
): Promise<PublishSourceTables> {
  const rowsByDatasetId = new Map<string, Record<string, unknown>[]>(),
    specByDatasetId = new Map<string, unknown>(),
    columnsByDatasetId = new Map<string, SqlColumnSpec[]>(),
    geometryById = new Map<string, unknown>(),
    injectGeometry = needsGeometryPlumbing(spec);
  const loadComponent = async (datasetId: string): Promise<void> => {
    const entries = await fetchDatasetEntryRows(datasetId, { convex, entryOrder: "asc" });
    rowsByDatasetId.set(
      datasetId,
      entries.map((entry) => publishRecordOf(entry, injectGeometry)),
    );
    // Metadata read for the declared structure (NOT a row path) — the same
    // read the analysis worker does, so both executors register identical
    // typed tables. A gone/non-component id simply carries no declared
    // typing (the tryGetSchema tolerance).
    let schema: FunctionReturnType<typeof api.schemas.get> = null;
    try {
      schema = await convex.query(api.schemas.get, { schemaId: datasetId });
    } catch {
      schema = null;
    }
    if (schema !== null) {
      columnsByDatasetId.set(datasetId, declaredColumnTypes(schema.schema));
    }
    for (const [id, payload] of await resolveGeometryRows(
      await fetchDatasetGeometryRows(datasetId, { convex }),
    )) {
      geometryById.set(id, payload);
    }
  };
  const visit = async (specValue: unknown): Promise<void> => {
    if (!isRecordShaped(specValue)) {
      return;
    }
    for (const dependency of transformSpecDependencies(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored specs are structural; the dependency walk reads ids only.
      specValue as unknown as TransformSpec,
    )) {
      if (rowsByDatasetId.has(dependency) || specByDatasetId.has(dependency)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- each load pages a dataset; sequential keeps memory bounded.
      const registryRow = await convex.query(api.derivedDatasets.get, { id: dependency });
      if (registryRow === null) {
        // oxlint-disable-next-line no-await-in-loop -- each load pages a dataset; sequential keeps memory bounded.
        await loadComponent(dependency);
      } else {
        specByDatasetId.set(dependency, registryRow.spec);
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await visit(registryRow.spec);
      }
    }
  };
  await visit(spec);
  return { columnsByDatasetId, geometryById, rowsByDatasetId, specByDatasetId };
}

/**
 * Executes a saved transform spec into chunk rows plus the frozen-row plan.
 * The early health gate mirrors what the host freeze enforces anyway — a
 * stale or orphaned transform fails here with the registry's own reason
 * before any upload starts.
 */
async function derivedPublish(
  convex: ConvexClient,
  datasetKey: string,
): Promise<{ chunkRows: ImportRow[]; plan: DerivedPlan }> {
  const row = await convex.query(api.derivedDatasets.get, { id: datasetKey });
  if (row === null) {
    throw new Error("The transform to publish no longer exists.");
  }
  if (row.health !== "ready") {
    throw new Error(
      `This transform can't publish yet (${row.health}): ${row.healthReason ?? "its sources have drifted"}.`,
    );
  }
  const tables = await loadPublishTables(convex, row.spec),
    // The SQL engine rides as a PROVIDER (stage 9, #105): a spec with no
    // sql operation never loads the WASM (the provider is never called);
    // a sql-bearing spec executes through the same `applySql` the analysis
    // worker runs — publish/preview parity, one engine path.
    execution = await executeSpecForPublish(row.spec, tables, {
      engine: analysisSqlEngine,
      limit: MAX_ANALYSIS_RESULT_ROWS,
    }),
    rule = geometryRuleOf(row.spec);
  let geometryType: string | undefined;
  if (rule !== undefined && isRecordShaped(row.spec)) {
    geometryType = await geometryTypeOfRuleSide(convex, row.spec, rule);
  }
  return {
    chunkRows: chunkRowsOfExecution(execution),
    plan: {
      geometryType,
      kind: geometryType === undefined ? "standard" : "geospatial",
      schema: { ...inferSchemaFromData(execution.rows), title: row.title },
      spec: row.spec,
    },
  };
}

/** The geometry-source side dataset's geometry type, or undefined when that side carries none (→ a standard publish). */
async function geometryTypeOfRuleSide(
  convex: ConvexClient,
  spec: Record<string, unknown>,
  rule: GeometrySource,
): Promise<string | undefined> {
  const operations = Array.isArray(spec.operations) ? spec.operations : [];
  const addressed = geometrySourceOperationOf(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stored operations are structurally the engine's union; the addressing reads ids only.
    operations as TransformSpec["operations"],
    rule,
  );
  if (addressed === undefined) {
    return undefined;
  }
  const sideDatasetId =
    rule.side === "lookup"
      ? rule.lookupDatasetId
      : typeof spec.sourceDatasetId === "string"
        ? spec.sourceDatasetId
        : "";
  if (sideDatasetId === "") {
    return undefined;
  }
  let dataset: { geometryType?: string } | null = null;
  try {
    dataset = await convex.query(api.schemas.get, { schemaId: sideDatasetId });
  } catch {
    // A registry-row side has no component doc — and no geometry of its own.
    return undefined;
  }
  return dataset === null ? undefined : dataset.geometryType;
}

/** The outcome of a publish the attempt already carried (nothing left to upload or freeze). */
async function settledOutcome(
  convex: ConvexClient,
  attemptId: AttemptId,
  status: string,
): Promise<PublishOutcome> {
  // The attempt already froze — its workflow (or its result) stands.
  const attempt = await convex.query(api.publish.attempt, { attemptId });
  return {
    attemptId,
    importId: attempt === null ? undefined : attempt.importId,
    schemaId: attempt === null ? undefined : attempt.publishedSchemaId,
    status,
  };
}

/**
 * Uploads and registers one chunk (the importer's producer shape: upload URL
 * → POST → register). The URL is issued for THIS attempt (`scope`), and the
 * registration presents the issuance token (`uploadId`) — a storage id that
 * didn't come from a server-issued upload for this attempt is rejected at
 * `registerChunk` (issue #131).
 */
async function uploadChunk(
  convex: ConvexClient,
  attemptId: AttemptId,
  chunk: ImportRow[],
  index: number,
): Promise<void> {
  const { storageUrl, uploadId } = await convex.mutation(api.imports.generateUploadUrl, {
    scope: attemptId,
  });
  const upload = await fetch(storageUrl, {
    body: JSON.stringify(chunk),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!upload.ok) {
    throw new Error(`Chunk ${index} upload failed (HTTP ${upload.status}).`);
  }
  const body: unknown = await upload.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("storageId" in body) ||
    typeof body.storageId !== "string"
  ) {
    throw new Error("Chunk upload did not return a storage id.");
  }
  await convex.mutation(api.publish.registerChunk, {
    attemptId,
    storageId: body.storageId,
    uploadId,
  });
}

/**
 * Uploads every chunk the attempt doesn't have yet, in order — registration
 * order is the resume index, so each chunk's registration depends on the
 * previous one landing.
 */
async function uploadPendingChunks(
  convex: ConvexClient,
  attemptId: AttemptId,
  chunks: ImportRow[][],
  from: number,
): Promise<void> {
  for (let index = from; index < chunks.length; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- order is the resume index; each registration depends on the previous landing.
    await uploadChunk(convex, attemptId, chunks[index], index);
  }
}

/**
 * The resume decision for a joined attempt, from the three counts the client
 * knows: the dead attempt's plan (`plannedChunkCount`), what it managed to
 * register (`registeredCount`), and what THIS execution produced
 * (`executedCount`). The whole AC-4 guarantee lives in these three branches:
 * - no plan yet → upload from zero;
 * - plan and execution disagree → the stored chunks describe a publish that
 *   no longer exists, so RESET (discard them all) and upload from zero —
 *   resuming into the old list would skip chunks the freeze then misses, and
 *   the next retry would re-upload overlapping ranges into the append-only
 *   list (duplicates + losses);
 * - a registered count ABOVE the plan is the same inconsistency from the
 *   other side (a racing or replayed registration) — reset for the same
 *   reason, because the freeze would otherwise refuse forever (the plan
 *   matches the execution, so the disagreement is invisible to the count
 *   the reset trigger normally reads);
 * - otherwise the normal resume: skip exactly the registered prefix.
 */
export function resumePlan(
  plannedChunkCount: number | undefined,
  registeredCount: number,
  executedCount: number,
): { from: number; reset: boolean } {
  if (plannedChunkCount === undefined) {
    return { from: 0, reset: false };
  }
  if (plannedChunkCount !== executedCount || registeredCount > plannedChunkCount) {
    return { from: 0, reset: true };
  }
  return { from: Math.min(registeredCount, executedCount), reset: false };
}

/**
 * Publishes one draft dataset or saved transform: start (or join) the
 * attempt → execute → plan → upload (skipping already-stored chunks) →
 * freeze. Returns once the freeze has handed the import to the durable
 * workflow; subscribe to `api.publish.attempt` for the outcome.
 */
export async function publishDataset(options: {
  convex?: ConvexClient;
  datasetKey: string;
}): Promise<PublishOutcome> {
  const convex = options.convex === undefined ? sharedClient() : options.convex,
    started = await convex.mutation(api.publish.start, { datasetKey: options.datasetKey });
  if (started.status === "importing" || started.status === "completed") {
    return settledOutcome(convex, started.attemptId, started.status);
  }

  const derived = await executeForPublish(convex, started.datasetKind, options.datasetKey),
    chunks = chunkRowsForImport(derived.chunkRows),
    resume = resumePlan(started.plannedChunkCount, started.chunkCount, chunks.length);
  if (resume.reset) {
    // The stored chunks describe a publish that no longer exists.
    await convex.mutation(api.publish.resetUpload, { attemptId: started.attemptId });
  }
  await convex.mutation(api.publish.plan, {
    attemptId: started.attemptId,
    chunkCount: chunks.length,
    ...(derived.plan === undefined
      ? {}
      : {
          geometryType: derived.plan.geometryType,
          kind: derived.plan.kind,
          schema: derived.plan.schema,
          spec: derived.plan.spec,
        }),
    totalRows: derived.chunkRows.length,
  });
  await uploadPendingChunks(convex, started.attemptId, chunks, resume.from);
  const frozen = await convex.mutation(api.publish.freeze, { attemptId: started.attemptId });
  return {
    attemptId: started.attemptId,
    importId: frozen.importId,
    schemaId: frozen.schemaId,
    status: "importing",
  };
}

// The module's one load-bearing side reference beyond the seam:
// needsGeometryPlumbing decides whether source records carry the injected
// geometry pointer (see publish-spec.ts) — re-exported for the tests that
// pin the coordination.
export { needsGeometryPlumbing };
