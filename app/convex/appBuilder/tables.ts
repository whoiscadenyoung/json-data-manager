import { defineTable } from "convex/server";
import { v } from "convex/values";

import { sharingValidator, widgetValidator } from "./validators";

/**
 * The app builder's tables, spread into `convex/schema.ts` with one line so
 * the whole feature is removable (docs/app-builder.md "Removing the app
 * builder").
 *
 * One row per app. Widgets live INLINE as a bounded array (`APP_LIMITS`:
 * ≤ 40 small config objects, no row data) rather than a child table: the
 * builder saves the whole layout at once (reorders and resizes touch every
 * widget's position anyway), and one document makes that save atomic and
 * the viewer's read a single subscription. `revision` is the optimistic-
 * concurrency counter `saveContent` checks, so two open editor tabs can't
 * silently overwrite each other.
 */
export const appBuilderTables = {
  apps: defineTable({
    /** Better Auth user id (`users.authId`) — attribution AND the ownership key: only the creator edits. */
    createdBy: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    sharing: sharingValidator,
    /** The app's data sources (component dataset ids); widgets may only reference these. */
    datasetIds: v.array(v.string()),
    widgets: v.array(widgetValidator),
    revision: v.number(),
    updatedAt: v.number(),
  }).index("by_createdBy", ["createdBy"]),
};
