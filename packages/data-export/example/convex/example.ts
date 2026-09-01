import { v } from "convex/values";
import type { Auth } from "convex/server";
import {
  defineExportCodec,
  exportReader,
  exposeApi,
  readExportTable,
  startExport,
  type ExportId,
} from "@caden/data-export";
import { components, internal } from "./_generated/api.js";
import { action, mutation } from "./_generated/server.js";
import schema from "./schema.js";

// The host table reader the export component pages through. Registering it as an
// internal function makes it a real reference we can hand to the component.
export const readTablePage = exportReader();

async function getAuthUserId(ctx: { auth: Auth }) {
  return (await ctx.auth.getUserIdentity())?.subject ?? "anonymous";
}

// Seed some data so there's something to export (example/demo only).
export const seed = mutation({
  args: { users: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const count = args.users ?? 3;
    for (let i = 0; i < count; i++) {
      const userId = await ctx.db.insert("users", {
        name: `User ${i}`,
        email: `user${i}@example.com`,
      });
      await ctx.db.insert("posts", {
        authorId: userId,
        title: `Post by user ${i}`,
        body: "Hello, world!",
      });
    }
  },
});

// Kick off an export directly with the low-level helper.
export const runExport = mutation({
  args: {
    tableNames: v.optional(v.array(v.string())),
    batchSize: v.optional(v.number()),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ExportId> => {
    return await startExport(ctx, components.dataExport, {
      tableNames: args.tableNames ?? ["users", "posts"],
      reader: internal.example.readTablePage,
      // Capture the declared shape of each table for typed read-back later.
      schema,
      batchSize: args.batchSize,
      label: args.label,
    });
  },
});

// A codec for reading `users` back with a stable, current shape. If a future
// version of the app splits `name` into `firstName`/`lastName`, add an upcaster
// keyed by the older snapshot's `schemaVersion` to keep old exports readable.
const usersCodec = defineExportCodec({
  current: v.object({
    _id: v.string(),
    _creationTime: v.number(),
    name: v.string(),
    email: v.string(),
  }),
  upcasters: {
    // Example: a hypothetical old snapshot that stored `email` under `emailAddress`.
    // deadbeef: (doc) => ({ ...doc, email: doc.emailAddress }),
  },
});

// Read an export's `users` back into the backend as typed rows.
export const readExportedUsers = action({
  args: { exportId: v.string() },
  handler: async (ctx, args): Promise<Array<{ name: string; email: string }>> => {
    return await readExportTable(ctx, components.dataExport, {
      exportId: args.exportId as ExportId,
      table: "users",
      codec: usersCodec,
    });
  },
});

// Or expose a ready-made authenticated API for clients.
export const {
  startExport: startExportAuth,
  cancelExport,
  deleteExport,
  listExports,
  getExport,
  getExportFiles,
  getDownloadUrls,
} = exposeApi(components.dataExport, {
  reader: internal.example.readTablePage,
  auth: async (ctx, operation) => {
    const userId = await getAuthUserId(ctx);
    // Allow anonymous reads in the demo; require auth to mutate.
    if (userId === "anonymous" && operation.type !== "read") {
      throw new Error("Unauthorized");
    }
    return userId;
  },
});
