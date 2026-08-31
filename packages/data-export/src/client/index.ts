import {
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
import type { ComponentApi } from "../component/_generated/component.js";
import type { Id } from "../component/_generated/dataModel.js";

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
 * const exportId = await startExport(ctx, components.dataExport, {
 *   tableNames: ["users", "posts"],
 *   reader: internal.exports.readTablePage,
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
  },
): Promise<ExportId> {
  const readerHandle = await createFunctionHandle(args.reader);
  return (await ctx.runMutation(component.lib.start, {
    tableNames: args.tableNames,
    readerHandle,
    batchSize: args.batchSize,
    label: args.label,
  })) as ExportId;
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
        return await ctx.runMutation(component.lib.start, {
          tableNames: args.tableNames,
          readerHandle,
          batchSize: args.batchSize,
          label: args.label,
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
  };
}

// Minimal `ctx` shapes so callers can pass whatever context they hold.
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
