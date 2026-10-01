import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/**
 * Host-side entry point for the component's abandoned-upload sweep (issue
 * #131): every upload URL the component mints records a `pendingUploads`
 * row, and one that was never claimed by a consumer (a publish or import
 * whose browser died between upload and registration) is dead after the
 * component's TTL. The cron below drives this daily; the component batches
 * and self-continues, so the host wrapper stays this thin.
 */
export const sweepAbandoned = internalMutation({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(components.jsonCms.host_support.sweepAbandonedUploads, {}),
  returns: v.number(),
});
