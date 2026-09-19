import type { Auth } from "convex/server";
import { ConvexError } from "convex/values";

import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";

/**
 * TODO(auth): the app has no authentication yet, so identity is a constant
 * "anonymous". The operation-aware half below is the app-side half of the
 * bound-datasets read-only gate: writes targeting a read-only dataset are
 * rejected here — the one choke point every exposeApi-wrapped mutation flows
 * through. Two kinds of dataset are read-only: a live projection with a
 * `datasetBindings` row (a synced external source) and a frozen tag version
 * (`lineage` on the component's schema doc). The sync and tag ingest call the
 * component directly (not through exposeApi), so both are unaffected.
 *
 * Allowed on read-only datasets: schema metadata edits (`updateSchema`) and
 * organization (collection/group membership) — the data is read-only, not the
 * filing. Deletion is blocked too: removing a bound dataset goes through the
 * explicit unbind flow (`bindings.unbind`), and version datasets retire via
 * `tags.retireVersion` — both call the component directly with the host-only
 * `boundWrite` attestation.
 *
 * Since #75, enforcement no longer depends on this choke point: the
 * component itself rejects data mutations on `source`/`lineage`-marked
 * schemas unless the caller carries the `boundWrite` attestation
 * (`assertDataWritable` in the component), which no exposeApi wrapper can
 * carry — that closes `startSimplification`/`startGeospatialConversion` too,
 * whose `{schemaId, "update"}` shape was indistinguishable from organization
 * ops here. This gate stays as the user-facing first line (friendlier error,
 * one fewer round trip) and for the paths only it can see. Real auth
 * (identity beyond "anonymous") remains a separate TODO.
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
      (await isReadOnlyDataset(mutationCtx, schemaId))
    ) {
      throw new ConvexError(
        "This dataset is synced from a connected source and is read-only here — edit the source data and re-sync instead.",
      );
    }
  }
  return "anonymous";
}

async function isReadOnlyDataset(ctx: MutationCtx, schemaId: string): Promise<boolean> {
  // `.first()` resolves to NULL when nothing matches — `!== undefined` was
  // always true, which gated every dataset (all entry writes rejected) as
  // soon as the bindings feature deployed. Found while setting up the
  // #71 two-tab rebuild drive.
  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_schema", (q) => q.eq("schemaId", schemaId))
    .first();
  if (binding !== null) {
    return true;
  }
  // A frozen tag version has no binding row of its own — its lineage marks
  // it read-only the same way. Only the datasets that fail the binding
  // check pay this extra component read.
  const schema = await ctx.runQuery(components.jsonCms.lib.getSchema, { schemaId });
  return schema !== null && schema.lineage !== undefined;
}

async function entrySchemaId(ctx: MutationCtx, entryId: string): Promise<string | undefined> {
  const entry = await ctx.runQuery(components.jsonCms.lib.getEntry, { entryId });
  if (entry === null) {
    return undefined;
  }
  return entry.schemaId;
}
