import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { appBuilderTables } from "./appBuilder/tables";
import { cmsTables } from "./cms/tables";
import { demoSourceTables } from "./demoSources/tables";
import { layerStyleTables } from "./layerStyles/tables";
import { publishingTables } from "./publishing/tables";
import { sourceTables } from "./sources/tables";
import { versionTables } from "./versions/tables";

// App-specific tables coexist with the @caden/json-cms component's own
// tables (which stay namespaced inside the component — nothing here touches
// them). `datasetBindings` is the first cut of the bound-datasets design's
// binding registry (docs/bound-datasets-design.md): it points a json-cms
// dataset at a registered source (./sources/registry.ts).
export default defineSchema({
  // The app builder (docs/app-builder.md) — its own table(s), spread in so the
  // feature stays removable with this one line.
  ...appBuilderTables,
  // Map layer styles (docs/layer-styles.md) — optional module, removable
  // with this one line plus its folder.
  ...layerStyleTables,
  // The demo foreign app's source tables (docs/bound-datasets-design.md) —
  // removable with this one line plus ./demoSources and its registry line in
  // ./sources/registry.ts.
  ...demoSourceTables,

  // Core domains (ADR 0014): each domain folder owns its tables.
  ...cmsTables,
  ...sourceTables,
  ...versionTables,
  ...publishingTables,

  // The app-side user profile, one row per Better Auth user. `authId` is the
  // Better Auth user id (the `user._id` inside the @convex-dev/better-auth
  // component — Better Auth's user/session/account tables stay namespaced in
  // the component and never appear in this schema). Rows are maintained
  // exclusively by the component's user triggers in auth.ts; don't insert or
  // delete them anywhere else. Email/name mirror the auth record so UI can
  // render the signed-in user from one query.
  users: defineTable({
    authId: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    name: v.optional(v.string()),
  })
    .index("by_authId", ["authId"])
    .index("by_email", ["email"]),
});
