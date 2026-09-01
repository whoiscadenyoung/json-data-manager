import {
  actionGeneric,
  createFunctionHandle,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type {
  Auth,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { v } from "convex/values";
import type { Infer, Validator } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";

/**
 * Structural shape of a Convex `defineSchema(...)` result — enough to read each
 * table's validator JSON. Passing your schema lets the component record the
 * declared shape of every exported table.
 */
export type SchemaLike = {
  tables: Record<string, { validator: unknown }>;
};

/**
 * Extract per-table validator JSON for the given tables from a schema. Tables
 * not present in the schema (e.g. schemaless) are simply omitted.
 *
 * Convex validators expose a serializable `.json` at runtime even though it
 * isn't in their public type, hence the cast.
 */
export function extractSchemas(schema: SchemaLike, tableNames: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of tableNames) {
    const table = schema.tables[name];
    if (table) {
      out[name] = (table.validator as { json: unknown }).json;
    }
  }
  return out;
}

/**
 * Branded ID types for the component's own tables, re-exported for consumers.
 * The host app doesn't get these from its own generated `dataModel` because the
 * component owns the tables.
 */
export type ExportId = Id<"exports">;
export type ExportFileId = Id<"exportFiles">;

/**
 * The reference type of a host "table reader" produced by {@link exportReader}.
 * Pass one of these to {@link startExport} / {@link exposeApi} so the component
 * can page through your tables.
 */
export type ReaderReference = FunctionReference<
  "query",
  "internal",
  { table: string; cursor: string | null; numItems: number },
  { page: unknown[]; isDone: boolean; continueCursor: string }
>;

/**
 * Build the host-side table reader the export component uses to stream your
 * data. Export the result from a Convex module so it becomes a real function
 * reference, then hand that reference to {@link startExport} or
 * {@link exposeApi}.
 *
 * It runs in your app's context (unlike the component), so it can read any of
 * your tables generically by name. It is registered as an internal function, so
 * it is never exposed to your clients directly.
 *
 * ```ts
 * // convex/exports.ts
 * import { exportReader } from "@caden/data-export";
 * export const readTablePage = exportReader();
 * ```
 */
export function exportReader() {
  return internalQueryGeneric({
    args: {
      table: v.string(),
      cursor: v.union(v.string(), v.null()),
      numItems: v.number(),
    },
    returns: v.object({
      page: v.array(v.any()),
      isDone: v.boolean(),
      continueCursor: v.string(),
    }),
    handler: async (ctx, args) => {
      // `table` is a runtime string; with the host's concrete data model this
      // reads whichever table was requested.
      const result = await ctx.db
        .query(args.table as unknown as never)
        .paginate({ cursor: args.cursor, numItems: args.numItems });
      return {
        page: result.page as unknown[],
        isDone: result.isDone,
        continueCursor: result.continueCursor,
      };
    },
  });
}

/**
 * Start an export snapshot of the given tables. Returns the new export's ID.
 *
 * ```ts
 * import schema from "./schema";
 * const exportId = await startExport(ctx, components.dataExport, {
 *   tableNames: ["users", "posts"],
 *   reader: internal.exports.readTablePage,
 *   schema, // capture the declared shape of each table
 *   batchSize: 500,
 *   label: "nightly",
 * });
 * ```
 */
export async function startExport(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  args: {
    tableNames: string[];
    reader: ReaderReference;
    batchSize?: number;
    label?: string;
    /** Your `defineSchema(...)` result — records each table's declared shape. */
    schema?: SchemaLike;
    /** Or supply the per-table validator JSON directly. */
    schemas?: Record<string, unknown>;
    /** Version label for this shape (defaults to a hash of the schemas). */
    schemaVersion?: string;
  },
): Promise<ExportId> {
  const readerHandle = await createFunctionHandle(args.reader);
  const schemas =
    args.schemas ?? (args.schema ? extractSchemas(args.schema, args.tableNames) : undefined);
  return (await ctx.runMutation(component.lib.start, {
    tableNames: args.tableNames,
    readerHandle,
    batchSize: args.batchSize,
    label: args.label,
    schemas,
    schemaVersion: args.schemaVersion,
  })) as ExportId;
}

/**
 * A codec for reading exported rows back with a stable, typed shape. `current`
 * is a Convex validator describing today's shape (decoded rows are typed as
 * `Infer<current>`); `upcasters`, keyed by the `schemaVersion` a snapshot was
 * written with, migrate older rows forward. The codec is plain isomorphic TS,
 * so the same instance works on the backend ({@link readExportTable}) and on
 * the frontend ({@link decodeExportText}).
 *
 * ```ts
 * const usersCodec = defineExportCodec({
 *   current: v.object({ email: v.string(), fullName: v.string() }),
 *   upcasters: {
 *     // a snapshot written under version "a1b2c3d4" only had `name`
 *     a1b2c3d4: (doc) => ({ email: doc.email, fullName: doc.name }),
 *   },
 * });
 * ```
 */
export type ExportCodec<T> = {
  decode(doc: unknown, schemaVersion: string | null): T;
};

export function defineExportCodec<V extends Validator<any, any, any>>(config: {
  current: V;
  upcasters?: Record<string, (doc: any) => unknown>;
}): ExportCodec<Infer<V>> {
  return {
    decode(doc, schemaVersion) {
      const upcaster = schemaVersion != null ? config.upcasters?.[schemaVersion] : undefined;
      return (upcaster ? upcaster(doc) : doc) as Infer<V>;
    },
  };
}

/**
 * Read a table's exported documents back into your backend, applying an
 * optional {@link ExportCodec} so you get today's typed shape even from older
 * snapshots. Must run in an action (it reads file storage).
 *
 * ```ts
 * const users = await readExportTable(ctx, components.dataExport, {
 *   exportId,
 *   table: "users",
 *   codec: usersCodec,
 * });
 * // users: { email: string; fullName: string }[]
 * ```
 */
export async function readExportTable<T = unknown>(
  ctx: ActionCtx,
  component: ComponentApi,
  args: {
    exportId: ExportId;
    table: string;
    codec?: ExportCodec<T>;
    batchSize?: number;
  },
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const page: {
      rows: unknown[];
      isDone: boolean;
      continueCursor: string;
      schemaVersion: string | null;
      schema: unknown;
      rowCount: number;
    } = await ctx.runAction(component.lib.readTable, {
      exportId: args.exportId,
      tableName: args.table,
      cursor,
      numItems: args.batchSize,
    });
    for (const doc of page.rows) {
      out.push(args.codec ? args.codec.decode(doc, page.schemaVersion) : (doc as T));
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return out;
}

/**
 * Parse a downloaded `.jsonl` file's text into rows, applying an optional
 * {@link ExportCodec}. For frontend use after fetching a file's download URL.
 */
export function decodeExportText<T = unknown>(
  text: string,
  schemaVersion: string | null,
  codec?: ExportCodec<T>,
): T[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const doc = JSON.parse(line) as unknown;
      return codec ? codec.decode(doc, schemaVersion) : (doc as T);
    });
}

export async function cancelExport(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  exportId: ExportId,
): Promise<void> {
  await ctx.runMutation(component.lib.cancelExport, { exportId });
}

export async function deleteExport(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  exportId: ExportId,
): Promise<void> {
  await ctx.runMutation(component.lib.deleteExport, { exportId });
}

export async function getExport(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: ComponentApi,
  exportId: ExportId,
) {
  return await ctx.runQuery(component.lib.getExport, { exportId });
}

export async function listExports(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: ComponentApi,
  args?: {
    status?: "pending" | "running" | "completed" | "failed" | "canceled";
    limit?: number;
  },
) {
  return await ctx.runQuery(component.lib.listExports, {
    status: args?.status,
    limit: args?.limit,
  });
}

export async function getDownloadUrls(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: ComponentApi,
  exportId: ExportId,
) {
  return await ctx.runQuery(component.lib.getDownloadUrls, { exportId });
}

/**
 * Re-export a ready-made, authenticated API for use from your clients.
 *
 * ```ts
 * // convex/exports.ts
 * export const readTablePage = exportReader();
 * export const {
 *   startExport, cancelExport, deleteExport,
 *   listExports, getExport, getExportFiles, getDownloadUrls,
 * } = exposeApi(components.dataExport, {
 *   reader: internal.exports.readTablePage,
 *   auth: async (ctx, op) => {
 *     const userId = await getAuthUserId(ctx);
 *     if (!userId) throw new Error("Unauthorized");
 *     return userId;
 *   },
 * });
 * ```
 */
export function exposeApi(
  component: ComponentApi,
  options: {
    /** The host table reader from {@link exportReader}. */
    reader: ReaderReference;
    /**
     * Your `defineSchema(...)` result. When provided, each export records the
     * declared shape of the tables it snapshots (for typed read-back).
     */
    schema?: SchemaLike;
    /** Version label for the current schema (defaults to a hash). */
    schemaVersion?: string;
    /**
     * Authorize each operation. Exports read your entire tables, so guard them
     * carefully — return the acting user's ID or throw.
     */
    auth: (
      ctx: { auth: Auth },
      operation:
        | { type: "read"; exportId?: string }
        | { type: "create"; tableNames: string[] }
        | { type: "cancel"; exportId: string }
        | { type: "delete"; exportId: string },
    ) => Promise<string>;
  },
) {
  return {
    startExport: mutationGeneric({
      args: {
        tableNames: v.array(v.string()),
        batchSize: v.optional(v.number()),
        label: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, {
          type: "create",
          tableNames: args.tableNames,
        });
        const readerHandle = await createFunctionHandle(options.reader);
        const schemas = options.schema
          ? extractSchemas(options.schema, args.tableNames)
          : undefined;
        return await ctx.runMutation(component.lib.start, {
          tableNames: args.tableNames,
          readerHandle,
          batchSize: args.batchSize,
          label: args.label,
          schemas,
          schemaVersion: options.schemaVersion,
        });
      },
    }),
    cancelExport: mutationGeneric({
      args: { exportId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "cancel", exportId: args.exportId });
        return await ctx.runMutation(component.lib.cancelExport, {
          exportId: args.exportId,
        });
      },
    }),
    deleteExport: mutationGeneric({
      args: { exportId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "delete", exportId: args.exportId });
        return await ctx.runMutation(component.lib.deleteExport, {
          exportId: args.exportId,
        });
      },
    }),
    listExports: queryGeneric({
      args: {
        status: v.optional(
          v.union(
            v.literal("pending"),
            v.literal("running"),
            v.literal("completed"),
            v.literal("failed"),
            v.literal("canceled"),
          ),
        ),
        limit: v.optional(v.number()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read" });
        return await ctx.runQuery(component.lib.listExports, {
          status: args.status,
          limit: args.limit,
        });
      },
    }),
    getExport: queryGeneric({
      args: { exportId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", exportId: args.exportId });
        return await ctx.runQuery(component.lib.getExport, {
          exportId: args.exportId,
        });
      },
    }),
    getExportFiles: queryGeneric({
      args: { exportId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", exportId: args.exportId });
        return await ctx.runQuery(component.lib.getExportFiles, {
          exportId: args.exportId,
        });
      },
    }),
    getDownloadUrls: queryGeneric({
      args: { exportId: v.string() },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", exportId: args.exportId });
        return await ctx.runQuery(component.lib.getDownloadUrls, {
          exportId: args.exportId,
        });
      },
    }),
    // Read a page of a table's exported rows back. Clients can paginate with
    // `cursor` and apply an ExportCodec to the returned rows themselves.
    readTable: actionGeneric({
      args: {
        exportId: v.string(),
        tableName: v.string(),
        cursor: v.optional(v.string()),
        numItems: v.optional(v.number()),
      },
      handler: async (ctx, args) => {
        await options.auth(ctx, { type: "read", exportId: args.exportId });
        return await ctx.runAction(component.lib.readTable, {
          exportId: args.exportId,
          tableName: args.tableName,
          cursor: args.cursor,
          numItems: args.numItems,
        });
      },
    }),
  };
}

// Minimal `ctx` shapes so callers can pass whatever context they hold.
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
