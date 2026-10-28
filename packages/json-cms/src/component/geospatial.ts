import { extractPointGeometry } from "@caden/data-core/coordinate-columns";
import {
  GEOMETRY_SIMPLIFY_DECIMAL_PLACES,
  roundGeometryCoordinates,
} from "@caden/data-core/geojson";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server.js";
import {
  byteLength,
  inlineGeometryFieldsOrThrow,
  parseAndValidateGeometry,
  resolveGeometryStorage,
} from "./geometry_storage.js";
import { paginateEntriesBySchema } from "./internal/entryPages.js";
import {
  bumpMapTileCacheVersion,
  deleteGeometryStorageIfAny,
  replaceEntryGeometry,
  simplifyGeometryPayload,
} from "./internal/entryWrites.js";
import { MAX_GEOMETRY_PAGE_ROWS, paginateGeometriesBySchema } from "./internal/geometryPages.js";
import { assertNoActiveDataRun, assertValidTotal } from "./internal/importRuns.js";
import { assertDataWritable, boundWriteValidator, workflow } from "./internal/shared.js";

// ---------------------------------------------------------------------------
// Convert an already-imported "standard" dataset to geospatial in place,
// backfilling a Point geometry for every existing entry from two of its own
// data fields (e.g. "Latitude"/"Longitude" columns) — for a dataset like a
// TIGER export that already has coordinate columns but wasn't imported as
// GeoJSON. Reuses the same `imports` status doc / workflow-monitoring
// machinery as a fresh import (see the module doc comment above) so the
// client can show the same progress UI, even though no file upload is
// involved here — the coordinates already live in the entries' own `data`.
//
// A Point geometry's JSON text is always a few dozen bytes, nowhere near
// `INLINE_GEOMETRY_BYTE_LIMIT` — so unlike the general import path, this
// never needs file-storage fallback, which means every step here can be a
// plain mutation (no action needed just to reach `ctx.storage.store`).
// ---------------------------------------------------------------------------

const CONVERSION_BATCH_SIZE = 100; // Entries are thin (no geometry payload) — safe to read in one pass, unlike geometry pages which need the byte budget.

/**
 * Converts one page of a schema's entries: builds a Point geometry from
 * `data[latField]`/`data[lonField]` for each (via `extractPointGeometry`,
 * shared with the client-side coordinate-column picker), skipping any row
 * whose coordinates are missing/invalid rather than failing the whole batch
 * — a dataset backfilled this way commonly has some ungeocodable rows.
 * Reuses `replaceEntryGeometry` per row so `featureCount`/`boundingBox` stay
 * correct; re-reads the schema doc each time since it's patched every
 * iteration this same execution (reads see this transaction's own writes).
 */
export const convertEntriesBatchInternal = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const { page, isDone, continueCursor } = await paginateEntriesBySchema(
      ctx,
      args.schemaId,
      args.cursor,
      CONVERSION_BATCH_SIZE,
    );

    let geocoded = 0;
    for (const entry of page) {
      const point = extractPointGeometry(entry.data, args.latField, args.lonField);
      if (point === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- each iteration depends on the previous one's featureCount/boundingBox patch.
      const schemaDoc = await ctx.db.get(args.schemaId);
      if (!schemaDoc) {
        throw new ConvexError("Schema not found");
      }
      const simplifiedPoint = simplifyGeometryPayload(point, JSON.stringify(point), schemaDoc),
        resolved = inlineGeometryFieldsOrThrow(
          simplifiedPoint.geometryJson,
          simplifiedPoint.geometry,
        );
      // oxlint-disable-next-line no-await-in-loop
      await replaceEntryGeometry(ctx, entry, schemaDoc, resolved);
      geocoded += 1;
    }

    return { continueCursor, examined: page.length, geocoded, isDone };
  },
  returns: v.object({
    continueCursor: v.string(),
    examined: v.number(),
    geocoded: v.number(),
    isDone: v.boolean(),
  }),
});

/** Durable workflow: convert a standard dataset's entries page by page, updating progress as it goes. */
export const geospatialConversionWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.imports.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0,
      cursor: string | null = null,
      isDone = false;
    // Sequential for the same reason `importWorkflow` is: memory stays
    // bounded and progress lands incrementally as each page completes.
    while (!isDone) {
      // Explicitly typed (rather than inferred from the call) to avoid a
      // circular type reference: `internal.lib` is typed from this same
      // module, and `geospatialConversionWorkflow` — currently being
      // type-checked — is one of its exports.
      const result: {
        continueCursor: string;
        examined: number;
        geocoded: number;
        isDone: boolean;
      } =
        // oxlint-disable-next-line no-await-in-loop
        await step.runMutation(internal.geospatial.convertEntriesBatchInternal, {
          cursor,
          latField: args.latField,
          lonField: args.lonField,
          schemaId: args.schemaId,
        });
      processed += result.examined;
      cursor = result.continueCursor;
      isDone = result.isDone;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.imports.updateImportProgress, {
        importId: args.importId,
        processed,
      });
    }

    await step.runMutation(internal.imports.updateImportProgress, {
      importId: args.importId,
      processed,
      status: "completed",
    });
  },
});

/** The property names declared on a schema doc's JSON Schema, or `{}` if it's malformed/propertyless. */
function schemaPropertyNames(schemaDoc: { schema: unknown }): Record<string, unknown> {
  const { schema: jsonSchema } = schemaDoc;
  if (
    jsonSchema &&
    typeof jsonSchema === "object" &&
    "properties" in jsonSchema &&
    typeof jsonSchema.properties === "object" &&
    jsonSchema.properties !== null
  ) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the `typeof === "object"` check above; a JSON Schema's `properties` is always a plain object.
    return jsonSchema.properties as Record<string, unknown>;
  }
  return {};
}

/** Throws unless `latField`/`lonField` are a usable, distinct pair of this schema's own properties. */
function assertConversionFieldsValid(
  schemaDoc: { kind?: "standard" | "geospatial"; schema: unknown },
  latField: string,
  lonField: string,
): void {
  if (schemaDoc.kind === "geospatial") {
    throw new ConvexError("This dataset is already geospatial.");
  }
  if (!latField.trim() || !lonField.trim()) {
    throw new ConvexError("Choose latitude and longitude columns.");
  }
  if (latField === lonField) {
    throw new ConvexError("Latitude and longitude must be different columns.");
  }
  const properties = schemaPropertyNames(schemaDoc);
  if (!(latField in properties) || !(lonField in properties)) {
    throw new ConvexError("Latitude/longitude fields must be properties of this dataset's schema.");
  }
}

/**
 * Flips a "standard" dataset to "geospatial" (locked to Point) and starts a
 * durable workflow that backfills a Point geometry for every existing entry
 * from its own `latField`/`lonField` data columns. The schema's `kind`
 * changes immediately (so the map tab/entry form appear right away); entries
 * without valid coordinates in those columns are simply left without
 * geometry, same as any other geometry-less row.
 */
export const startGeospatialConversion = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    // Conversion rewrites every entry's geometry payload, so it is a data
    // mutation even though it shares the organization ops' operation shape in
    // exposeApi — component-level enforcement is what blocks it on bound
    // datasets (docs/bound-datasets-design.md §9, phase 1 remainder).
    boundWrite: boundWriteValidator,
    latField: v.string(),
    lonField: v.string(),
    schemaId: v.id("schemas"),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);
    assertConversionFieldsValid(schemaDoc, args.latField, args.lonField);
    assertValidTotal(args.total);
    await assertNoActiveDataRun(ctx, args.schemaId);

    await ctx.db.patch(args.schemaId, {
      boundingBox: undefined,
      featureCount: 0,
      geometryType: "Point",
      kind: "geospatial",
    });
    // Membership rows cache `kind` (see `schemaCollections` in schema.ts) —
    // rewrite this dataset's rows in the same transaction so collection
    // views see the flip immediately.
    const memberships = await ctx.db
      .query("schemaCollections")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .collect();
    await Promise.all(
      memberships.map(async (row) => {
        if (row.kind !== "geospatial") {
          await ctx.db.patch(row._id, { kind: "geospatial" });
        }
      }),
    );

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.geospatial.geospatialConversionWorkflow,
        { importId, latField: args.latField, lonField: args.lonField, schemaId: args.schemaId },
        {
          context: { importId },
          onComplete: internal.imports.handleImportComplete,
          startAsync: true,
        },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});

// ---------------------------------------------------------------------------
// Simplify an existing geospatial dataset's geometries: round every stored
// coordinate payload to GEOMETRY_SIMPLIFY_DECIMAL_PLACES. Launched from the
// dataset page's action menu (the importer's "Simplify geometry" checkbox
// covers new datasets at creation; existing data is deliberately NOT migrated
// automatically). Reuses the `imports` status doc + progress/completion
// machinery (`updateImportProgress`/`handleImportComplete`) so the UI can
// monitor it exactly like an import or geospatial conversion.
//
// The batch step must be an action (not a mutation) because storage-backed
// geometries' payloads are only readable via `ctx.storage.get`. Each batch
// is one durable workflow step; rounding is idempotent, so a retried step
// that already wrote some rows before failing simply re-rounds them.
//
// Like the import path, each row's post-rounding storage form is re-decided
// (rounding only ever shrinks a payload, so a row can move from a storage
// blob back inline, never the reverse) and the replaced blob is deleted.
// ---------------------------------------------------------------------------

/**
 * One batch of a dataset's geometry rows as the simplify action needs them:
 * pointers plus payload (inline text here, or the action reads the blob
 * itself). Paged through `paginateGeometriesBySchema`'s shared cursor — the
 * cursor is `_creationTime`, which a patch never changes, so rows rewritten
 * by earlier batches are never revisited.
 */
export const listSimplifyBatchInternal = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const result = await paginateGeometriesBySchema(ctx, args.schemaId, {
      cursor: args.cursor,
      numItems: args.numItems,
    });
    return {
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      page: result.page.map((row) => ({
        geometryJson: row.geometryJson,
        geometryStorageId: row.geometryStorageId,
        id: row._id,
      })),
    };
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    page: v.array(
      v.object({
        geometryJson: v.optional(v.string()),
        geometryStorageId: v.optional(v.id("_storage")),
        id: v.id("geometries"),
      }),
    ),
  }),
});

/**
 * Writes one batch of already-rounded payloads back onto their `geometries`
 * rows — guarded by a compare-and-swap on the payload each row carried when
 * the simplify action read it (issue #129): a row whose inline text or
 * storage blob changed since the read was edited concurrently, and
 * overwriting it here would revert that edit, so it is SKIPPED and counted
 * instead. Clears whichever storage form each applied row no longer uses and
 * deletes the blob it replaced. Returns how many rows were applied and how
 * many were left untouched.
 */
export const applySimplifiedGeometriesInternal = internalMutation({
  args: {
    updates: v.array(
      v.object({
        bbox: v.optional(v.array(v.number())),
        // The CAS tokens: exactly what the action read for this row (the
        // inline text, or the immutable blob's id). A row matches only if
        // what it carries NOW is still what the action rounded FROM.
        expectedGeometryJson: v.optional(v.string()),
        expectedGeometryStorageId: v.optional(v.id("_storage")),
        geometryJson: v.optional(v.string()),
        geometryStorageId: v.optional(v.id("_storage")),
        id: v.id("geometries"),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let applied = 0,
      skipped = 0,
      touchedSchemaId: Id<"schemas"> | undefined;
    for (const update of args.updates) {
      // oxlint-disable-next-line no-await-in-loop -- the batch is one transaction; row writes land in order under its write budget.
      const existing = await ctx.db.get(update.id);
      if (existing === null) {
        skipped += 1; // Deleted (or its whole dataset went) mid-run.
        continue;
      }
      // Compare-and-swap (issue #129): blobs are immutable, so an unchanged
      // storage id proves the payload is the one that was read; inline rows
      // compare their text. A mismatch means the row was written to during
      // the batch — leave the newer value alone.
      const unchanged =
        (update.expectedGeometryJson !== undefined &&
          existing.geometryJson === update.expectedGeometryJson) ||
        (update.expectedGeometryStorageId !== undefined &&
          existing.geometryStorageId === update.expectedGeometryStorageId);
      if (!unchanged) {
        skipped += 1;
        continue;
      }
      touchedSchemaId ??= existing.schemaId;
      // The row's old blob is always superseded by this write: either the
      // rounded payload moved back inline, or it was re-stored as a NEW blob
      // (storage blobs are immutable), so the old one is unreferenced now.
      // oxlint-disable-next-line no-await-in-loop
      await deleteGeometryStorageIfAny(ctx, existing);
      // oxlint-disable-next-line no-await-in-loop
      await ctx.db.patch(update.id, {
        bbox: update.bbox,
        geometry: undefined,
        geometryJson: update.geometryJson,
        geometryStorageId: update.geometryStorageId,
      });
      applied += 1;
    }
    // One bump per batch write, not per row — the batch is one transaction,
    // so consumers only need to know the data changed at all (and the
    // simplify workflow's batches land back-to-back; per-row bumps would
    // just inflate the counter meaninglessly). Read fresh: earlier batches
    // in the same workflow already bumped this same doc.
    if (touchedSchemaId !== undefined) {
      const schemaDoc = await ctx.db.get(touchedSchemaId);
      if (schemaDoc) {
        await bumpMapTileCacheVersion(ctx, touchedSchemaId, schemaDoc);
      }
    }
    return { applied, skipped };
  },
  returns: v.object({ applied: v.number(), skipped: v.number() }),
});

// Rows per simplify batch: the same ceiling `listGeometries` honors — the
// shared paginator's byte budget (not this number) is what actually bounds
// how much payload one batch reads (each row's payload can be up to
// INLINE_GEOMETRY_BYTE_LIMIT).
const SIMPLIFY_BATCH_ROWS = MAX_GEOMETRY_PAGE_ROWS,
  // Payload bytes handed to `applySimplifiedGeometriesInternal` per call —
  // matched to the bulk import path, whose 4 MB chunk-per-mutation precedent
  // is proven against Convex's per-transaction write budget.
  SIMPLIFY_WRITE_CHUNK_BYTES = 4_000_000;

/**
 * Rounds ONE batch of the schema's geometry payloads and writes them back.
 * Runs as a workflow step (see the module comment above for why an action is
 * required). Malformed payloads — which current write paths never produce —
 * are skipped rather than failing the batch, and the skip is COUNTED and
 * reported (issue #129: the old bare `catch {}` made a partial run read as a
 * clean one). Returns how many rows were rewritten, how many were skipped
 * (unreadable payloads, concurrent edits lost to the compare-and-swap), and
 * the pagination cursor. Blobs stored for rows whose apply never lands are
 * deleted on the failure path, so an interrupted attempt orphans nothing.
 */
export const simplifyGeometryBatchInternal = internalAction({
  args: {
    cursor: v.union(v.string(), v.null()),
    schemaId: v.id("schemas"),
  },
  // Explicit return type — the inferred one would flow back through this
  // handler's own `internal.lib` references and circularly reference the
  // export being defined (same reason `geospatialConversionWorkflow` types
  // its step result explicitly).
  handler: async (
    ctx,
    args,
  ): Promise<{ continueCursor: string; isDone: boolean; simplified: number; skipped: number }> => {
    const { continueCursor, isDone, page } = await ctx.runQuery(
      internal.geospatial.listSimplifyBatchInternal,
      {
        cursor: args.cursor,
        numItems: SIMPLIFY_BATCH_ROWS,
        schemaId: args.schemaId,
      },
    );

    let simplified = 0,
      skipped = 0,
      pendingBytes = 0;
    const pending: Array<{
        bbox?: number[];
        expectedGeometryJson?: string;
        expectedGeometryStorageId?: Id<"_storage">;
        geometryJson?: string;
        geometryStorageId?: Id<"_storage">;
        id: Id<"geometries">;
      }> = [],
      // Blobs `resolveGeometryStorage` stored for rows still awaiting their
      // apply — deleted if the step fails so they never orphan (issue #129).
      unappliedStorageIds: Array<Id<"_storage">> = [];
    // Flushes `pending` to the write mutation, chunked by payload bytes so a
    // full batch of near-limit geometries never exceeds the per-transaction
    // write budget the import path has already proven (see
    // SIMPLIFY_WRITE_CHUNK_BYTES).
    const flush = async () => {
      if (pending.length === 0) {
        return;
      }
      const result: { applied: number; skipped: number } = await ctx.runMutation(
        internal.geospatial.applySimplifiedGeometriesInternal,
        { updates: pending.splice(0) },
      );
      simplified += result.applied;
      skipped += result.skipped;
      unappliedStorageIds.length = 0;
      pendingBytes = 0;
    };

    try {
      for (const row of page) {
        try {
          let raw: string;
          if (row.geometryJson !== undefined) {
            raw = row.geometryJson;
          } else {
            // oxlint-disable-next-line no-await-in-loop -- per-row payload reads; the batch is bounded by the shared paginator's byte budget.
            const blob =
              row.geometryStorageId !== undefined
                ? // oxlint-disable-next-line no-await-in-loop
                  await ctx.storage.get(row.geometryStorageId)
                : null;
            if (blob === null) {
              throw new Error("Geometry payload blob is missing.");
            }
            // oxlint-disable-next-line no-await-in-loop
            raw = await blob.text();
          }
          const parsedGeometry = parseAndValidateGeometry(raw);
          // oxlint-disable-next-line no-await-in-loop -- storage-form resolution writes per row, chunked into the pending flush below.
          const rounded = roundGeometryCoordinates(
              parsedGeometry,
              GEOMETRY_SIMPLIFY_DECIMAL_PLACES,
            ),
            roundedJson = JSON.stringify(rounded);
          // oxlint-disable-next-line no-await-in-loop
          const resolved = await resolveGeometryStorage(ctx, rounded, roundedJson);
          if (resolved.geometryStorageId !== undefined) {
            unappliedStorageIds.push(resolved.geometryStorageId);
          }
          // `resolved` also carries `type` (unchanged by rounding) — only the
          // fields this write actually touches travel to the mutation,
          // alongside the CAS tokens (what the row carried when read).
          pending.push({
            bbox: resolved.bbox,
            expectedGeometryJson: row.geometryJson,
            expectedGeometryStorageId: row.geometryStorageId,
            geometryJson: resolved.geometryJson,
            geometryStorageId: resolved.geometryStorageId,
            id: row.id,
          });
          pendingBytes += byteLength(roundedJson);
        } catch (rowError) {
          // Unreadable/unparseable payload — leave the row as-is and keep
          // the batch moving, but SAY so: the skip count rides the status
          // doc instead of vanishing (issue #129).
          skipped += 1;
          console.warn(
            `simplify: skipped geometry row ${row.id}:`,
            rowError instanceof Error ? rowError.message : rowError,
          );
        }
        if (pendingBytes >= SIMPLIFY_WRITE_CHUNK_BYTES) {
          // oxlint-disable-next-line no-await-in-loop -- chunked writes must land in payload order; inherently sequential.
          await flush();
        }
      }
      await flush();
    } catch (err) {
      // The step (or a flush) failed — every blob stored above for rows that
      // never got applied is unreferenced now. Best-effort delete, rethrow.
      await Promise.all(
        unappliedStorageIds.map(async (geometryStorageId) => {
          try {
            await ctx.storage.delete(geometryStorageId);
          } catch {
            // Already gone — best-effort cleanup on the failure path.
          }
        }),
      );
      throw err;
    }

    return { continueCursor, isDone, simplified, skipped };
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    simplified: v.number(),
    skipped: v.number(),
  }),
});

/** Durable workflow: round a dataset's geometry payloads batch by batch, updating progress as it goes. */
export const simplifyGeometryWorkflow = workflow.define({
  args: {
    importId: v.id("imports"),
    schemaId: v.id("schemas"),
  },
  handler: async (step, args): Promise<void> => {
    await step.runMutation(internal.imports.updateImportProgress, {
      importId: args.importId,
      processed: 0,
      status: "processing",
    });

    let processed = 0,
      skipped = 0,
      cursor: string | null = null,
      isDone = false;
    // Sequential for the same reason `importWorkflow` is: memory stays
    // bounded and progress lands incrementally as each batch completes.
    while (!isDone) {
      // Explicitly typed to avoid a circular type reference — see the same
      // pattern in `geospatialConversionWorkflow` above.
      const result: {
        continueCursor: string;
        isDone: boolean;
        simplified: number;
        skipped: number;
      } =
        // oxlint-disable-next-line no-await-in-loop
        await step.runAction(internal.geospatial.simplifyGeometryBatchInternal, {
          cursor,
          schemaId: args.schemaId,
        });
      processed += result.simplified;
      skipped += result.skipped;
      cursor = result.continueCursor;
      isDone = result.isDone;
      // oxlint-disable-next-line no-await-in-loop
      await step.runMutation(internal.imports.updateImportProgress, {
        importId: args.importId,
        processed,
        skipped,
      });
    }

    // A simplify run COMPLETES with skips surfaced (issue #129) — a skipped
    // row is a payload the run couldn't rewrite (or deliberately didn't:
    // the compare-and-swap), not a reason to fail the dataset's own request.
    // The count rides the status doc so the UI can show it.
    await step.runMutation(internal.imports.updateImportProgress, {
      importId: args.importId,
      processed,
      skipped,
      status: "completed",
    });
  },
});

/**
 * Rounds every stored geometry payload of a geospatial dataset to
 * GEOMETRY_SIMPLIFY_DECIMAL_PLACES via `simplifyGeometryWorkflow`, and flips
 * the dataset's `simplifyGeometry` flag so all future writes match. Reuses
 * the `imports` status doc (see the module comment above) — the returned id
 * feeds `getImportStatus` for live progress.
 */
export const startSimplification = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    // Simplification rewrites every stored geometry payload, so it is a data
    // mutation even though it shares the organization ops' operation shape in
    // exposeApi — component-level enforcement is what blocks it on bound
    // datasets (docs/bound-datasets-design.md §9, phase 1 remainder).
    boundWrite: boundWriteValidator,
    schemaId: v.id("schemas"),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      throw new ConvexError("Schema not found");
    }
    assertDataWritable(schemaDoc, args.boundWrite);
    if (schemaDoc.kind !== "geospatial") {
      throw new ConvexError("Only a geospatial dataset can simplify geometry.");
    }
    assertValidTotal(args.total);
    await assertNoActiveDataRun(ctx, args.schemaId);

    // Future writes (entry creates/updates, imports) simplify from now on,
    // matching the data this run is about to normalize.
    await ctx.db.patch(args.schemaId, { simplifyGeometry: true });

    const importId = await ctx.db.insert("imports", {
        processed: 0,
        schemaId: args.schemaId,
        status: "pending",
        total: args.total,
      }),
      workflowId = await workflow.start(
        ctx,
        internal.geospatial.simplifyGeometryWorkflow,
        { importId, schemaId: args.schemaId },
        {
          context: { importId },
          onComplete: internal.imports.handleImportComplete,
          startAsync: true,
        },
      );

    await ctx.db.patch(importId, { workflowId });
    return importId;
  },
  returns: v.id("imports"),
});
