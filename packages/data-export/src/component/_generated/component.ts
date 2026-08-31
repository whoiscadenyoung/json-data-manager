/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  lib: {
    cancelExport: FunctionReference<"mutation", "internal", { exportId: string }, null, Name>;
    deleteExport: FunctionReference<"mutation", "internal", { exportId: string }, null, Name>;
    getDownloadUrls: FunctionReference<
      "query",
      "internal",
      { exportId: string },
      {
        files: Array<{
          path: string;
          rowCount: number;
          sizeBytes: number;
          tableName: string;
          url: null | string;
        }>;
        manifestUrl: null | string;
      },
      Name
    >;
    getExport: FunctionReference<
      "query",
      "internal",
      { exportId: string },
      null | {
        _creationTime: number;
        _id: string;
        batchSize: number;
        completedAt?: number;
        error?: string;
        format: "jsonl";
        label?: string;
        manifestStorageId?: string;
        readerHandle: string;
        requestedAt: number;
        startedAt?: number;
        status: "pending" | "running" | "completed" | "failed" | "canceled";
        tableNames: Array<string>;
        totalBytes?: number;
        totalRows?: number;
        workflowId?: string;
      },
      Name
    >;
    getExportFiles: FunctionReference<
      "query",
      "internal",
      { exportId: string },
      Array<{
        _creationTime: number;
        _id: string;
        exportId: string;
        path: string;
        rowCount: number;
        sizeBytes: number;
        storageId: string;
        tableName: string;
      }>,
      Name
    >;
    listExports: FunctionReference<
      "query",
      "internal",
      {
        limit?: number;
        status?: "pending" | "running" | "completed" | "failed" | "canceled";
      },
      Array<{
        _creationTime: number;
        _id: string;
        batchSize: number;
        completedAt?: number;
        error?: string;
        format: "jsonl";
        label?: string;
        manifestStorageId?: string;
        readerHandle: string;
        requestedAt: number;
        startedAt?: number;
        status: "pending" | "running" | "completed" | "failed" | "canceled";
        tableNames: Array<string>;
        totalBytes?: number;
        totalRows?: number;
        workflowId?: string;
      }>,
      Name
    >;
    start: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        label?: string;
        readerHandle: string;
        tableNames: Array<string>;
      },
      string,
      Name
    >;
    workflowStatus: FunctionReference<"action", "internal", { workflowId: string }, any, Name>;
  };
};
