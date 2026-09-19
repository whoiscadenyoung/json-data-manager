import type { Auth } from "convex/server";
import { ConvexError } from "convex/values";

import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";

/**
 * TODO(auth): the app has no authentication yet, so identity is a constant
 * "anonymous". The operation-aware half below is the bound-datasets read-only
 * gate instead: writes targeting a dataset that has a `datasetBindings` row
 * (a synced external source) are rejected here — the one choke point every
 * exposeApi-wrapped mutation flows through. The sync itself calls the
 * component directly (not through exposeApi), so it is unaffected.
 *
 * Allowed on bound datasets: schema metadata edits (`updateSchema`) and
 * organization (collection/group membership) — the data is read-only, not the
 * filing. Deletion is blocked too: removing a bound dataset starts with
 * removing its binding row ("unbinding"), which turns it back into an
 * ordinary dataset. Known gaps while auth is anonymous:
 * `startSimplification`/`startGeospatialConversion` pass the same
 * `{schemaId, "update"}` shape as the organization ops and so are not
 * distinguishable here — component-level enforcement lands with real auth
 * (docs/bound-datasets-design.md phase 1).
 */
export async function auth(
  ctx: { auth: Auth },
  operation?: {
    type: "read" | "create" | "update" | "delete";
    schemaId?: string;
    entryId?: string;
  },
): Promise<string> {
  if (operation !== undefined && operation.type !== "read") {
    const mutationCtx = ctx as MutationCtx;
    let schemaId = operation.schemaId;
    if (schemaId === undefined && operation.entryId !== undefined) {
      schemaId = await entrySchemaId(mutationCtx, operation.entryId);
    }
    // Entry-targeted writes always touch data. Schema-targeted creates are
    // data operations (entries, imports); schema-targeted deletes are data
    // operations or dataset deletion (both gated); schema-targeted updates
    // are metadata/organization and stay allowed.
    if (
      schemaId !== undefined &&
      (operation.entryId !== undefined || operation.type !== "update") &&
      (await isBoundDataset(mutationCtx, schemaId))
    ) {
      throw new ConvexError(
        "This dataset is synced from a connected source and is read-only here — edit the source data and re-sync instead.",
      );
    }
  }
  return "anonymous";
}

async function isBoundDataset(ctx: MutationCtx, schemaId: string): Promise<boolean> {
  // `.first()` resolves to NULL when nothing matches — `!== undefined` was
  // always true, which gated every dataset (all entry writes rejected) as
  // soon as the bindings feature deployed. Found while setting up the
  // #71 two-tab rebuild drive.
  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
    .first();
  return binding !== null;
}

async function entrySchemaId(ctx: MutationCtx, entryId: string): Promise<string | undefined> {
  const entry = await ctx.runQuery(components.jsonCms.lib.getEntry, { entryId });
  if (entry === null) {
    return undefined;
  }
  return entry.schemaId;
}
