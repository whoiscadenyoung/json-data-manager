import { isGeometryCompatibleWithDatasetType } from "@caden/data-core/geojson";
import { GeoParseError, GeometryError } from "@caden/data-core/geojson";
import type { Geometry } from "@caden/data-core/geojson";
import { geometryTypeValidator } from "@caden/data-core/geojson";
import type { GeometryTypeArg } from "@caden/data-core/geojson";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import { parseAndValidateGeometry, resolveGeometryStorage } from "./geometry_storage.js";
import type { ResolvedGeometry } from "./geometry_storage.js";
import { claimPendingUpload } from "./host_support.js";
import {
  asResolvedGeometry,
  insertEntryBatch,
  simplifyGeometryPayload,
} from "./internal/entryWrites.js";
import { assertNoActiveDataRun, assertValidTotal } from "./internal/importRuns.js";
import { assertDataWritable, boundWriteValidator, workflow } from "./internal/shared.js";
import schema from "./schema.js";

// The fields a resolved geometry carries through the bulk-import path,
// once `import_prep.ts` has already validated it and decided inline vs.
// file storage — see `geometry_storage.ts`'s `ResolvedGeometry`.
const resolvedGeometryValidator = v.object({
  bbox: v.optional(v.array(v.number())),
  geometryJson: v.optional(v.string()),
  geometryStorageId: v.optional(v.id("_storage")),
  type: geometryTypeValidator,
});

// ---------------------------------------------------------------------------
// Batched, monitored dataset import
//
// Convex COMPONENTS cannot use the Node.js runtime (`"use node"` is an
// app-layer-only capability — components must stay portable/sandboxable),
// so no step running inside this component can ever safely download +
// `JSON.parse` a multi-tens-of-MB upload in one shot (the default action
// runtime caps out around 64 MB). Rather than doing that parse on the
// server at all, the CLIENT — which already fully parses the entire file
// in the browser for schema inference/validation before it ever calls
// `startImport` — splits the row payload into several already-small chunks
// itself (see `chunkRowsForImport` in the `react` package) and uploads each
// to its own storage blob via repeated `generateUploadUrl` + `fetch` POSTs.
//
// `startImport` then just records the resulting list of chunk storage ids
// and kicks off a durable workflow that, for each one, runs
// `insertChunkFromStorage` — an action that downloads ONE already-small
// chunk (safe in the default runtime), validates + resolves each row's
// geometry (inline vs. file storage — see `geometry_storage.ts`), and
// inserts it. No step ever holds more than one chunk's worth of data, and
// no geometry's coordinate payload ever crosses a Convex value boundary (a
// mutation argument or a document field) as a nested array larger than
// Convex's 8192-elements-per-array limit — it's always JSON text.
//
// Trade-off versus a single-pass, whole-import validation: since chunks are
// inserted as their step runs (not validated-then-committed atomically
// across the whole import), a bad row in a later chunk can leave earlier
// chunks already committed. This matches the pre-existing behavior before
// this file's `geometryJson`/`geometryStorageId` rework and is an accepted,
// documented trade-off of components being unable to use Node.
// ---------------------------------------------------------------------------

const importValidator = schema.tables.imports.validator.extend({
    _creationTime: v.number(),
    _id: v.id("imports"),
  }),
  // The public status view (issue #131): everything the progress UI and the
  // host pollers read, minus the chunk-blob pointers (`storageId` legacy /
  // `storageIds`) — no public query returns a `_storage` id. The workflow
  // receives the chunk ids through its own args, never through this result.
  importStatusValidator = importValidator.omit("storageId", "storageIds");

/**
 * Generate a short-lived URL the client POSTs one chunk of serialized rows to.
 * Called once per chunk.
 *
 * Every issuance is tracked server-side (issue #131): the return carries the
 * `pendingUploads` row this URL was minted with, and the consumer of the
 * uploaded blob (`startImport`'s client path; the host's chunk-registration
 * and tile-install flows) must present that `uploadId` to prove the blob came
 * through a server-issued URL — a claim against an unknown, already-used, or
 * differently-scoped row rejects the id. A claim deletes its row, so the
 * table only ever holds uploads that never reached a consumer — exactly what
 * `host_support.sweepAbandonedUploads` clears out.
 *
 * `scope` binds the issuance to its intended target: the host's publish
 * attempt id (chunk registration) or the component schema id (imports, tile
 * installs). Host-internal uploads (the tag ingest uploads server-side) issue
 * without one; a scope-less row can never satisfy a claim.
 */
export const generateUploadUrl = mutation({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const uploadId = await ctx.db.insert("pendingUploads", { scope: args.scope });
    return { storageUrl: await ctx.storage.generateUploadUrl(), uploadId };
  },
  returns: v.object({ storageUrl: v.string(), uploadId: v.string() }),
});

/** Read the import status doc (client subscribes to this for progress). */
export const getImportStatus = query({
  args: { importId: v.id("imports") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.importId);
    if (doc === null) {
      return null;
    }
    const { storageId: _legacyId, storageIds: _chunkIds, ...status } = doc;
    return status;
  },
  returns: v.union(importStatusValidator, v.null()),
});

/**
 * The completion record for one chunk of an import, if its rows are already
 * durably inserted — the replay check `insertChunkFromStorage` performs
 * (issue #129). `null` means "not yet inserted", `non-null` means "a prior
 * attempt of this step committed its rows and crashed before returning":
 * the replay must skip the insert and report the recorded row count, making
 * the step idempotent end to end.
 */
export const getImportChunkRecord = internalQuery({
  args: { chunkIndex: v.number(), importId: v.id("imports") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.importId);
    if (doc === null) {
      return null;
    }
    const record =
      doc.completedChunks !== undefined
        ? doc.completedChunks.find((chunk) => chunk.index === args.chunkIndex)
        : undefined;
    return record === undefined ? null : record;
  },
  returns: v.union(v.null(), v.object({ index: v.number(), rows: v.number() })),
});

/**
 * Resolves `startImport`'s chunk-blob provenance (issue #131's fork):
 * validates which of the two carrying shapes the import used, claims every
 * pending-upload row on the client path (any rejection rolls the whole
 * import back), and returns the chunk storage ids. Extracted from the
 * handler so its branch count stays manageable.
 *
 * The two carrying shapes:
 * - Client path (no `boundWrite`): every blob arrives as
 *   `{storageId, uploadId}` — the pending-upload row its upload URL was
 *   issued under. All rows are claimed here, in this transaction, so a
 *   storage id that wasn't issued for THIS dataset (unknown token, already
 *   spent, different scope) rejects the whole import.
 * - Host-attested path (`boundWrite` — the host's freeze/ingest flows, which
 *   no client wrapper can carry): plain ids the host flow vetted at its own
 *   boundary (publish chunks are claimed when they register; tag-ingest
 *   chunks are uploaded server-side).
 */
async function resolveImportStorageIds(
  ctx: MutationCtx,
  args: {
    boundWrite?: string;
    chunks?: Array<{ storageId: Id<"_storage">; uploadId: string }>;
    schemaId: Id<"schemas">;
    sourceFile?: { storageId: Id<"_storage">; uploadId: string };
    storageIds?: Array<Id<"_storage">>;
  },
): Promise<Array<Id<"_storage">>> {
  if (args.boundWrite !== undefined) {
    if (args.storageIds === undefined) {
      throw new ConvexError("An attested import must carry its chunk storage ids.");
    }
    if (args.chunks !== undefined) {
      throw new ConvexError("An attested import carries raw chunk ids, not upload tokens.");
    }
    return args.storageIds;
  }
  if (args.storageIds !== undefined) {
    throw new ConvexError(
      "This import carries raw storage ids — upload its chunks through issued URLs and pass each blob's token.",
    );
  }
  if (args.chunks === undefined) {
    throw new ConvexError(
      "This import carries no registered uploads — request upload URLs and pass each blob's token.",
    );
  }
  for (const chunk of args.chunks) {
    // oxlint-disable-next-line no-await-in-loop -- every claim consumes its row before the next read; any rejection rolls the whole import back.
    await claimPendingUpload(ctx, chunk.uploadId, args.schemaId);
  }
  if (args.sourceFile !== undefined) {
    await claimPendingUpload(ctx, args.sourceFile.uploadId, args.schemaId);
  }
  return args.chunks.map((chunk) => chunk.storageId);
}

/** Attaches (or replaces) the retained original-file blob on the schema doc, deleting the blob a previous import left referenced so the pointer swap never orphans it (issue #129; source-file retention is #46). */
async function attachSourceFile(
  ctx: MutationCtx,
  schemaId: Id<"schemas">,
  schemaDoc: { sourceFileStorageId?: Id<"_storage"> },
  sourceFile: { name: string; size: number; storageId: Id<"_storage"> },
): Promise<void> {
  if (
    schemaDoc.sourceFileStorageId !== undefined &&
    schemaDoc.sourceFileStorageId !== sourceFile.storageId
  ) {
    await ctx.storage.delete(schemaDoc.sourceFileStorageId);
  }
  await ctx.db.patch(schemaId, {
    sourceFileName: sourceFile.name,
    sourceFileStorageId: sourceFile.storageId,
    sourceFileSize: sourceFile.size,
  });
}

/**
 * Create the status doc and start the durable import workflow. Each chunk is
 * one already-small, client-uploaded blob (see the module doc comment above)
 * — each one gets its own `insertChunkFromStorage` step, which carries the
 * per-chunk completion journal that makes step replays no-ops (issue #129).
 */
export const startImport = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    boundWrite: boundWriteValidator,
    // The exact file this import came from, already uploaded by the client to
    // its own storage blob — retained on the schema doc so the original
    // (un-simplified) data stays re-downloadable even when geometry is being
    // simplified on write. Absent for imports that didn't provide one.
    // `uploadId` is the pending-upload row the blob was uploaded against.
    sourceFile: v.optional(
      v.object({
        name: v.string(),
        size: v.number(),
        storageId: v.id("_storage"),
        uploadId: v.string(),
      }),
    ),
    schemaId: v.id("schemas"),
    // Client path: one uploaded chunk blob per entry plus its upload token.
    chunks: v.optional(v.array(v.object({ storageId: v.id("_storage"), uploadId: v.string() }))),
    // Host-attested path: chunk blob ids vetted by the calling host flow.
    storageIds: v.optional(v.array(v.id("_storage"))),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const targetSchema = await ctx.db.get(args.schemaId);
    if (!targetSchema) {
      throw new ConvexError("Schema not found");
    }
    // An import writes entries, so a bound dataset only accepts one from its
    // host's tag-ingest flow.
    assertDataWritable(targetSchema, args.boundWrite);
    assertValidTotal(args.total);
    await assertNoActiveDataRun(ctx, args.schemaId);

    const storageIds = await resolveImportStorageIds(ctx, args);

    if (args.sourceFile !== undefined) {
      await attachSourceFile(ctx, args.schemaId, targetSchema, args.sourceFile);
    }

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        storageIds,
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.imports.importWorkflow,
        {
          importId,
          schemaId: args.schemaId,
          storageIds,
          total: args.total,
        },
        {
          // Carried through to `handleImportComplete` so a failed/canceled
          // import's not-yet-processed chunk blobs get cleaned up too (each
          // chunk deletes its own blob on success, inside the loop below).
          context: { importId, storageIds },
          onComplete: internal.imports.handleImportComplete,
          startAsync: true,
        },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});

/**
 * Best-effort delete of a storage blob referenced by a plain string id (the
 * form workflow steps pass storage ids in — see `insertChunkFromStorage`).
 * Swallows "already gone" rather than failing an otherwise-successful import
 * over cleanup. Takes the minimal structural storage surface both the
 * mutation and action contexts provide, so a workflow step's replay path can
 * call it from either.
 */
async function tryDeleteStorage(
  ctx: { storage: { delete(storageId: Id<"_storage">): Promise<void> } },
  storageId: string,
): Promise<void> {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see callers for why storage ids travel as plain strings here.
    await ctx.storage.delete(storageId as Id<"_storage">);
  } catch {
    // Already deleted, or never existed — fine, this is best-effort cleanup.
  }
}

/**
 * Runs after the import workflow finishes. On success every chunk already
 * deleted its own blob as it was consumed; here we only need to record
 * failures/cancels, and best-effort delete any chunk blobs the workflow
 * never got to (a failed/canceled import may have stopped partway through
 * `storageIds`) — deleting an already-consumed blob is a harmless no-op
 * (see `tryDeleteStorage`).
 */
/** Unpacks the context the import workflow stored: the import row id and the chunk blob ids. */
function unpackImportContext(context: unknown): { importId: unknown; storageIds: unknown } {
  const isObject = context !== null && typeof context === "object";
  return {
    importId:
      isObject && "importId" in context ? (context as { importId?: unknown }).importId : undefined,
    storageIds:
      isObject && "storageIds" in context
        ? (context as { storageIds?: unknown }).storageIds
        : undefined,
  };
}

/** Best-effort delete any chunk blobs the workflow never got to (a failed/canceled import may have stopped partway through `storageIds`) — deleting an already-consumed blob is a harmless no-op (see `tryDeleteStorage`). */
async function deleteLeftoverChunks(ctx: MutationCtx, storageIds: unknown): Promise<void> {
  if (!Array.isArray(storageIds)) {
    return;
  }
  await Promise.all(
    storageIds.map(async (id: unknown) => {
      if (typeof id === "string") {
        await tryDeleteStorage(ctx, id);
      }
    }),
  );
}

export const handleImportComplete = internalMutation({
  args: {
    context: v.any(),
    result: v.any(),
    workflowId: v.string(),
  },
  handler: async (ctx, args) => {
    const result = args.result,
      { importId, storageIds } = unpackImportContext(args.context);

    if (result && result.kind === "success") {
      return;
    }
    await deleteLeftoverChunks(ctx, storageIds);

    if (typeof importId !== "string") {
      return;
    }
    let error = "Import failed.";
    if (result && result.kind === "canceled") {
      error = "Import was canceled.";
    } else if (result && typeof result.error === "string") {
      error = result.error;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a string above; it's always the `Id<"imports">` `startImport` put into `context`.
    await ctx.db.patch(importId as Id<"imports">, { error, status: "failed" });
  },
});

/** Patch import progress/status. Called between workflow steps. */
export const updateImportProgress = internalMutation({
  args: {
    error: v.optional(v.string()),
    importId: v.id("imports"),
    processed: v.optional(v.number()),
    skipped: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.processed !== undefined) {
      patch.processed = args.processed;
    }
    if (args.skipped !== undefined) {
      patch.skipped = args.skipped;
    }
    if (args.status !== undefined) {
      patch.status = args.status;
    }
    if (args.error !== undefined) {
      patch.error = args.error;
    }
    await ctx.db.patch(args.importId, patch);
  },
  returns: v.null(),
});

/**
 * The import workflow's completion gate (issue #129): `processed` must equal
 * `total` or the import FAILS instead of reporting a false "completed" —
 * the check the workflow never made, which is how a lost/malformed chunk
 * used to pass as done. Lives in a step-callable mutation so the guard is
 * verifiable without running the workflow engine (see lib.test.ts's note).
 */
export const completeImport = internalMutation({
  args: { importId: v.id("imports"), processed: v.number(), total: v.number() },
  handler: async (ctx, args) => {
    if (args.processed !== args.total) {
      throw new ConvexError(
        `Imported ${args.processed} of ${args.total} rows — the import is incomplete and has been marked failed.`,
      );
    }
    await ctx.db.patch(args.importId, { processed: args.processed, status: "completed" });
  },
  returns: v.null(),
});

/**
 * Validates one row's geometry (if any) against the schema's locked
 * `kind`/`geometryType`, and resolves it to inline-vs-storage form (see
 * `resolveGeometryStorage`). Shared by `insertChunkFromStorage`'s per-row
 * loop; extracted so that loop's own complexity stays manageable.
 */
async function resolveImportRowGeometry(
  ctx: { storage: { store(blob: Blob, options?: { sha256?: string }): Promise<Id<"_storage">> } },
  rowIndex: number,
  geometry: unknown,
  schemaDoc: {
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    simplifyGeometry?: boolean;
  },
): Promise<ResolvedGeometry> {
  const kind = schemaDoc.kind ?? "standard";
  if (kind !== "geospatial" || schemaDoc.geometryType === undefined) {
    throw new ConvexError(`Row ${rowIndex}: cannot attach geometry to a standard dataset.`);
  }
  let geometryJson = JSON.stringify(geometry);
  let parsedGeometry: Geometry;
  try {
    parsedGeometry = parseAndValidateGeometry(geometryJson);
  } catch (err) {
    const message =
      err instanceof GeometryError || err instanceof GeoParseError
        ? err.message
        : "Invalid geometry.";
    throw new ConvexError(`Row ${rowIndex}: ${message}`);
  }
  if (!isGeometryCompatibleWithDatasetType(parsedGeometry.type, schemaDoc.geometryType)) {
    throw new ConvexError(
      `Row ${rowIndex}: geometry type "${parsedGeometry.type}" is not compatible with this dataset's "${schemaDoc.geometryType}" geometry type.`,
    );
  }
  const simplified = simplifyGeometryPayload(parsedGeometry, geometryJson, schemaDoc);
  return resolveGeometryStorage(ctx, simplified.geometry, simplified.geometryJson);
}

/**
 * Reads ONE already-small, client-uploaded chunk blob (raw `{data,
 * geometry?}[]` rows — see the module doc comment above for why chunking
 * happens client-side), validates + resolves each row's geometry, and
 * inserts the batch. Runs entirely in Convex's default action runtime — a
 * chunk is small enough by construction (see `chunkRowsForImport`) that this
 * never needs Node. Deletes its own chunk blob once the insert succeeds.
 * Returns the number of rows inserted.
 *
 * Step-retry semantics (issue #129, correcting the old "retried in
 * isolation" claim): the workflow engine journals a step's COMPLETION, so a
 * step that threw or whose execution crashed re-runs from its start — it is
 * not "retried in isolation" mid-flight, and an action's earlier side
 * effects (committed mutations, stored blobs) survive into the retry. That
 * window is closed two ways here:
 * - the row inserts record a per-chunk completion entry on the `imports`
 *   doc IN THE SAME TRANSACTION (`insertEntriesChunkInternal`), so a replay
 *   after "committed but never returned" finds the record and returns the
 *   recorded row count instead of inserting duplicates;
 * - geometry blobs this attempt stored for rows that never landed are
 *   deleted on the way out, so a failing row doesn't orphan them.
 * A step that THROWS (malformed chunk, bad row) fails the import — the
 * workflow engine runs a step once; only a crashed/interrupted step re-runs.
 */

/**
 * Validates and resolves every row of one parsed chunk (the per-row loop of
 * `insertChunkFromStorage`; extracted so that handler's own complexity stays
 * manageable). Appends every file-storage geometry blob it creates to
 * `storedGeometryIds` so the caller can clean them up if a later row (or the
 * insert itself) fails.
 */
async function resolveImportChunkRows(
  ctx: { storage: { store(blob: Blob, options?: { sha256?: string }): Promise<Id<"_storage">> } },
  rows: unknown[],
  schemaDoc: {
    kind?: "standard" | "geospatial";
    geometryType?: GeometryTypeArg;
    simplifyGeometry?: boolean;
  },
  storedGeometryIds: Array<Id<"_storage">>,
): Promise<Array<{ data: unknown; resolvedGeometry?: ResolvedGeometry }>> {
  const resolvedRows: Array<{ data: unknown; resolvedGeometry?: ResolvedGeometry }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (typeof row !== "object" || row === null) {
      throw new ConvexError(`Row ${i} is not an object.`);
    }
    // The uploaded chunk is always `{ data, geometry? }[]` — validated below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { data, geometry } = row as { data: unknown; geometry?: unknown };
    if (geometry === undefined) {
      resolvedRows.push({ data });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- storage writes must land in row order; this loop is inherently sequential.
    const resolvedGeometry = await resolveImportRowGeometry(ctx, i, geometry, schemaDoc);
    if (resolvedGeometry.geometryStorageId !== undefined) {
      storedGeometryIds.push(resolvedGeometry.geometryStorageId);
    }
    resolvedRows.push({ data, resolvedGeometry });
  }
  return resolvedRows;
}

export const insertChunkFromStorage = internalAction({
  args: {
    // The chunk's position in the import's `storageIds` — with `importId`,
    // keys the per-chunk completion journal. Optional only for the direct
    // test/one-off callers that predate the journal (the workflow always
    // passes both).
    chunkIndex: v.optional(v.number()),
    importId: v.optional(v.id("imports")),
    schemaId: v.id("schemas"),
    // A `_storage` id — passed as a plain string because system-table ids can't
    // Be journaled/validated as `v.id("_storage")` through the workflow engine.
    storageId: v.string(),
  },
  // Explicit return type — the inferred one flows back through this
  // handler's own `internal.lib` references (the replay-check query) and
  // circularly references the export being defined (the memory-note gotcha:
  // annotate steps whose results cross `internal.lib`).
  handler: async (ctx, args): Promise<number> => {
    const schemaDoc = await ctx.runQuery(internal.entries.getSchemaInternal, {
      schemaId: args.schemaId,
    });
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    const { chunkIndex, importId } = args;
    if (chunkIndex !== undefined && importId !== undefined) {
      const done: { index: number; rows: number } | null = await ctx.runQuery(
        internal.imports.getImportChunkRecord,
        { chunkIndex, importId },
      );
      if (done !== null) {
        // A previous attempt committed this chunk's rows and died before
        // returning. No duplicates — finish the blob cleanup it may have
        // missed and report the recorded count so `processed` stays exact.
        await tryDeleteStorage(ctx, args.storageId);
        return done.rows;
      }
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- actions have no `normalizeId`; `storageId` is always a real `_storage` id, just untyped over the workflow boundary.
    const blob = await ctx.storage.get(args.storageId as Id<"_storage">);
    if (!blob) {
      throw new ConvexError("Import chunk not found in storage");
    }
    const parsed: unknown = JSON.parse(await blob.text());
    if (!Array.isArray(parsed)) {
      // A non-array chunk used to read as ZERO rows and its blob was then
      // deleted — a silently lost chunk behind a "completed" import
      // (issue #129). Malformed input fails the import instead.
      throw new ConvexError(
        "Import chunk is malformed — expected an array of {data, geometry?} rows.",
      );
    }

    // Geometry blobs stored for this attempt's rows (only
    // `resolveGeometryStorage`'s file-storage fallbacks land here). If a
    // later row fails, the rows never insert — delete the blobs instead of
    // orphaning them (issue #129).
    const storedGeometryIds: Array<Id<"_storage">> = [];
    let insertedRows: Array<{ data: unknown; resolvedGeometry?: ResolvedGeometry }>;
    try {
      insertedRows = await resolveImportChunkRows(ctx, parsed, schemaDoc, storedGeometryIds);
      await ctx.runMutation(internal.imports.insertEntriesChunkInternal, {
        chunkIndex: args.chunkIndex,
        dataArray: insertedRows,
        importId: args.importId,
        schemaId: args.schemaId,
      });
    } catch (err) {
      // The rows never landed — the geometry blobs this attempt stored for
      // them are unreferenced now. Best-effort delete, then rethrow. (The
      // CHUNK blob's own delete stays outside this catch: once the rows are
      // in, the geometry blobs are referenced data, not litter.)
      await Promise.all(
        storedGeometryIds.map(async (geometryStorageId) => {
          try {
            await ctx.storage.delete(geometryStorageId);
          } catch {
            // Already gone — best-effort cleanup on the failure path.
          }
        }),
      );
      throw err;
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    await ctx.storage.delete(args.storageId as Id<"_storage">);
    return insertedRows.length;
  },
  returns: v.number(),
});

/**
 * Insert one pre-resolved batch of entries in a single transaction. Each
 * row's geometry was already structurally validated and resolved (inline
 * vs. file storage) by `insertChunkFromStorage` — this only re-checks the
 * cheap dataset-type-compatibility rule before writing.
 *
 * When called with `importId` + `chunkIndex` (the workflow's chunk path),
 * the per-chunk completion record is written HERE, in the same transaction
 * as the inserts (issue #129) — that atomicity is what makes a replayed
 * chunk step a no-op rather than a duplicate insert.
 */
export const insertEntriesChunkInternal = internalMutation({
  args: {
    chunkIndex: v.optional(v.number()),
    dataArray: v.array(
      v.object({ data: v.any(), resolvedGeometry: v.optional(resolvedGeometryValidator) }),
    ),
    importId: v.optional(v.id("imports")),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }

    await insertEntryBatch(
      ctx,
      args.schemaId,
      schemaDoc,
      args.dataArray.map((row) => ({
        data: row.data,
        geometry:
          row.resolvedGeometry === undefined ? undefined : asResolvedGeometry(row.resolvedGeometry),
      })),
    );

    if (args.importId !== undefined && args.chunkIndex !== undefined) {
      const importDoc = await ctx.db.get(args.importId);
      if (importDoc !== null) {
        // Replace-by-index (defensive: the replay check upstream normally
        // prevents double-marking) so the journal stays one row per chunk.
        const completedChunks = (importDoc.completedChunks ?? [])
          .filter((chunk) => chunk.index !== args.chunkIndex)
          .concat([{ index: args.chunkIndex, rows: args.dataArray.length }]);
        await ctx.db.patch(args.importId, { completedChunks });
      }
    }
    return null;
  },
  returns: v.null(),
});

/** Durable workflow: insert each client-uploaded chunk in turn, updating progress as it goes. */
export const importWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    schemaId: v.id("schemas"),
    storageIds: v.array(v.string()), // `_storage` ids as strings (see insertChunkFromStorage)
    total: v.number(),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.imports.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0;
    // Chunks run sequentially so memory stays bounded and progress lands
    // incrementally; parallelizing the steps would defeat both. Each step is
    // replay-safe (see `insertChunkFromStorage`'s doc comment); a step that
    // throws — a malformed chunk, a bad row — fails the whole import.
    for (const [chunkIndex, storageId] of args.storageIds.entries()) {
      // oxlint-disable-next-line no-await-in-loop
      const inserted: number = await step.runAction(internal.imports.insertChunkFromStorage, {
        chunkIndex,
        importId: args.importId,
        schemaId: args.schemaId,
        storageId,
      });
      processed += inserted;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.imports.updateImportProgress, {
        importId: args.importId,
        processed,
      });
    }

    // The completion gate (issue #129): mark "completed" only when every
    // expected row landed; otherwise `completeImport` throws and the
    // workflow finishes failed (`handleImportComplete` records it).
    await step.runMutation(internal.imports.completeImport, {
      importId: args.importId,
      processed,
      total: args.total,
    });
  },
});
