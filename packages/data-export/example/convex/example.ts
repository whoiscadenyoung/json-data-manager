import { v } from "convex/values";
import type { Auth } from "convex/server";
import { exportReader, exposeApi, startExport, type ExportId } from "@caden/data-export";
import { components, internal } from "./_generated/api.js";
import { mutation } from "./_generated/server.js";

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
      batchSize: args.batchSize,
      label: args.label,
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
