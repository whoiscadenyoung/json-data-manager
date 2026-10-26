import { defineTable } from "convex/server";
import { v } from "convex/values";

import { pageValidator, sharingValidator, widgetValidator } from "./validators";

/**
 * The app builder's tables, spread into `convex/schema.ts` with one line so
 * the whole feature is removable (docs/app-builder.md "Removing the app
 * builder").
 *
 * One row per app. Pages and their widgets live INLINE as bounded arrays
 * (`APP_LIMITS`: ≤ 12 pages, ≤ 80 small widget configs, no row data) rather
 * than child tables: the builder saves the whole layout at once (reorders and
 * resizes touch every widget's position anyway), and one document makes that
 * save atomic and the viewer's read a single subscription. `revision` is the optimistic-
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
    /** The app's tabs, in order. Absent only on documents saved before pages existed (read via `appPages`). */
    pages: v.optional(v.array(pageValidator)),
    /** Legacy single-page layout; replaced by `pages` on the next save. */
    widgets: v.optional(v.array(widgetValidator)),
    /** Seeded example apps (`examples.ts`): listed in the Examples gallery, readable by everyone signed in, edited by no one. */
    example: v.optional(v.boolean()),
    revision: v.number(),
    updatedAt: v.number(),
  })
    .index("by_createdBy", ["createdBy"])
    .index("by_example", ["example"]),
};
