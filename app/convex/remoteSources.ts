import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { auth } from "./auth";
import { fetchManifestLayer, type RemoteManifestLayer } from "./remoteClient";
import { getRemoteSource, remoteSources } from "./sources";

/**
 * Remote bound sources, v1 (#78, docs/remote-source-adapter-design.md §5):
 * the manifest check that drives "update available", and the user-initiated
 * Sync that starts the shared sync engine from the live manifest. No commit
 * feed and no automatic syncing — the cron only checks.
 *
 * Staleness reuses the binding's `sourceUpdatedAt` stamp: a check that sees
 * the layer's revision past the binding's synced `remoteRevision` stamps it,
 * so every existing "Out of date" badge covers remote sources unchanged.
 */

// A check older than this is refreshed when a dataset page or the
// dashboard asks (`checkIfStale`); the cron covers everything else.
const CHECK_FRESH_MS = 60_000;

const layerValidator = v.object({
  description: v.optional(v.string()),
  featureCount: v.optional(v.number()),
  geometryType: v.string(),
  revision: v.number(),
  schema: v.any(),
  schemaVersion: v.string(),
  title: v.string(),
});

const statusValidator = v.object({
  bindingId: v.optional(v.id("datasetBindings")),
  checkedAt: v.optional(v.number()),
  checkError: v.optional(v.string()),
  // The layer as the remote manifest last described it.
  latest: v.optional(layerValidator),
  lastSyncedAt: v.optional(v.number()),
  layerKey: v.string(),
  // True when the remote layer's revision has moved past what was synced
  // (or the source was never synced).
  outOfDate: v.boolean(),
  recordUrlTemplate: v.optional(v.string()),
  schemaChanged: v.boolean(),
  schemaId: v.optional(v.string()),
  source: v.string(),
  syncedEntryCount: v.optional(v.number()),
  syncedRevision: v.optional(v.number()),
  syncedSchemaVersion: v.optional(v.string()),
  title: v.string(),
});

/** The binding's side of a status row (all absent before the first sync). */
function bindingFields(binding: Doc<"datasetBindings"> | null) {
  if (binding === null) {
    return {};
  }
  return {
    bindingId: binding._id,
    lastSyncedAt: binding.lastSyncedAt,
    schemaId: binding.schemaId,
    syncedEntryCount: binding.syncedEntryCount,
    syncedRevision: binding.remoteRevision,
    syncedSchemaVersion: binding.remoteSchemaVersion,
  };
}

/** The latest check's side of a status row (all absent before the first check). */
function checkFields(check: Doc<"remoteSourceChecks"> | null) {
  if (check === null) {
    return {};
  }
  return {
    checkError: check.error,
    checkedAt: check.checkedAt,
    latest: check.layer,
    recordUrlTemplate: check.recordUrlTemplate,
  };
}

function statusOf(
  sourceKey: string,
  binding: Doc<"datasetBindings"> | null,
  check: Doc<"remoteSourceChecks"> | null,
) {
  const source = getRemoteSource(sourceKey);
  const synced = bindingFields(binding),
    checked = checkFields(check);
  const { latest } = checked,
    { syncedRevision, syncedSchemaVersion } = synced;
  return {
    ...synced,
    ...checked,
    layerKey: source.layer,
    outOfDate:
      syncedRevision === undefined || (latest !== undefined && latest.revision > syncedRevision),
    schemaChanged:
      latest !== undefined &&
      syncedSchemaVersion !== undefined &&
      latest.schemaVersion !== syncedSchemaVersion,
    source: sourceKey,
    title: latest === undefined ? source.dataset.title : latest.title,
  };
}

/** Every registered remote source with its binding + latest check — the dashboard card. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    return Promise.all(
      remoteSources().map(async (source) => {
        const [binding, latestCheck] = await Promise.all([
          ctx.db
            .query("datasetBindings")
            .withIndex("by_source", (q) => q.eq("source", source.key))
            .first(),
          ctx.db
            .query("remoteSourceChecks")
            .withIndex("by_source", (q) => q.eq("source", source.key))
            .first(),
        ]);
        return statusOf(source.key, binding, latestCheck);
      }),
    );
  },
  returns: v.array(statusValidator),
});

/** One remote source's status by source key — null for local sources. */
export const status = query({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    if (!remoteSources().some((source) => source.key === args.source)) {
      return null;
    }
    const [binding, latestCheck] = await Promise.all([
      ctx.db
        .query("datasetBindings")
        .withIndex("by_source", (q) => q.eq("source", args.source))
        .first(),
      ctx.db
        .query("remoteSourceChecks")
        .withIndex("by_source", (q) => q.eq("source", args.source))
        .first(),
    ]);
    return statusOf(args.source, binding, latestCheck);
  },
  returns: v.union(v.null(), statusValidator),
});

export const getCheck = internalQuery({
  args: { source: v.string() },
  handler: async (ctx, args) =>
    ctx.db
      .query("remoteSourceChecks")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .first(),
  returns: v.any(),
});

/**
 * Stamps the binding's `sourceUpdatedAt` when the remote revision has moved
 * past the synced one — the signal every existing "Out of date" badge reads.
 * A binding that is already stale (or never synced) is left alone.
 */
async function markStaleIfBehind(
  ctx: MutationCtx,
  source: string,
  revision: number,
  now: number,
): Promise<void> {
  const binding = await ctx.db
    .query("datasetBindings")
    .withIndex("by_source", (q) => q.eq("source", source))
    .first();
  if (binding === null || binding.remoteRevision === undefined) {
    return;
  }
  const alreadyStale =
    binding.sourceUpdatedAt !== undefined &&
    (binding.lastSyncedAt === undefined || binding.sourceUpdatedAt > binding.lastSyncedAt);
  if (revision > binding.remoteRevision && !alreadyStale) {
    await ctx.db.patch(binding._id, { sourceUpdatedAt: now });
  }
}

/**
 * Records one manifest check: the latest layer (or the error, keeping the
 * last good layer), and — when the layer's revision has moved past the
 * binding's synced revision — the binding's `sourceUpdatedAt` stamp, unless
 * it is already marked stale.
 */
export const recordCheck = internalMutation({
  args: {
    error: v.optional(v.string()),
    layer: v.optional(layerValidator),
    recordUrlTemplate: v.optional(v.string()),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("remoteSourceChecks")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .first();
    // A failed check keeps the last good layer.
    const kept = checkFields(existing);
    const fields = {
      checkedAt: now,
      error: args.error,
      layer: args.layer ?? kept.latest,
      recordUrlTemplate: args.recordUrlTemplate ?? kept.recordUrlTemplate,
      source: args.source,
    };
    if (existing === null) {
      await ctx.db.insert("remoteSourceChecks", fields);
    } else {
      await ctx.db.replace(existing._id, fields);
    }
    if (args.layer !== undefined) {
      await markStaleIfBehind(ctx, args.source, args.layer.revision, now);
    }
    return null;
  },
  returns: v.null(),
});

/** Fetches the manifest and records the result; returns the layer, or null after recording an error. */
async function checkSource(ctx: ActionCtx, sourceKey: string): Promise<RemoteManifestLayer | null> {
  const source = getRemoteSource(sourceKey);
  try {
    const manifest = await fetchManifestLayer(source);
    await ctx.runMutation(internal.remoteSources.recordCheck, {
      layer: {
        description: manifest.layer.description,
        featureCount: manifest.layer.featureCount,
        geometryType: manifest.layer.geometryType,
        revision: manifest.layer.revision,
        schema: manifest.layer.schema,
        schemaVersion: manifest.layer.schemaVersion,
        title: manifest.layer.title,
      },
      recordUrlTemplate: manifest.recordUrlTemplate,
      source: sourceKey,
    });
    return manifest;
  } catch (error) {
    await ctx.runMutation(internal.remoteSources.recordCheck, {
      error: error instanceof Error ? error.message : "The remote check failed.",
      source: sourceKey,
    });
    return null;
  }
}

/** "Check now": re-reads the remote manifest for one source. */
export const check = action({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const manifest = await checkSource(ctx, args.source);
    return { ok: manifest !== null };
  },
  returns: v.object({ ok: v.boolean() }),
});

/**
 * The page-open refresh: checks only when the last check is older than
 * CHECK_FRESH_MS, so opening a page repeatedly doesn't hammer the source.
 */
export const checkIfStale = action({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    await auth(ctx);
    const existing: Doc<"remoteSourceChecks"> | null = await ctx.runQuery(
      internal.remoteSources.getCheck,
      { source: args.source },
    );
    if (existing !== null && Date.now() - existing.checkedAt < CHECK_FRESH_MS) {
      return { checked: false };
    }
    await checkSource(ctx, args.source);
    return { checked: true };
  },
  returns: v.object({ checked: v.boolean() }),
});

/** The cron's pass: one manifest check per registered remote source. */
export const checkAll = internalAction({
  args: {},
  handler: async (ctx) => {
    await Promise.all(
      remoteSources().map(async (source) => {
        await checkSource(ctx, source.key);
      }),
    );
    return null;
  },
  returns: v.null(),
});

/**
 * Sync: re-reads the manifest, refuses when the layer's schemaVersion moved
 * past the one the dataset was built from, then starts the sync engine's
 * full-state run (which also creates the dataset from this layer on first
 * bind). The run itself drains the rows inside its collect action.
 */
export const sync = action({
  args: { source: v.string() },
  handler: async (ctx, args): Promise<{ alreadyRunning: boolean; runId: Id<"syncRuns"> }> => {
    await auth(ctx);
    const manifest = await checkSource(ctx, args.source);
    if (manifest === null) {
      const failed: Doc<"remoteSourceChecks"> | null = await ctx.runQuery(
        internal.remoteSources.getCheck,
        { source: args.source },
      );
      throw new ConvexError(
        failed !== null && failed.error !== undefined
          ? `Couldn't reach the source: ${failed.error}`
          : "Couldn't reach the source.",
      );
    }
    const current: ReturnType<typeof statusOf> | null = await ctx.runQuery(
      internal.remoteSources.statusInternal,
      { source: args.source },
    );
    if (current !== null && current.schemaChanged) {
      throw new ConvexError(
        `The source's schema changed (v${current.syncedSchemaVersion ?? "?"} → v${manifest.layer.schemaVersion}). Unbind and sync again to rebuild the dataset.`,
      );
    }
    const { layer } = manifest;
    return ctx.runMutation(internal.sync.startRemoteRun, {
      dataset: {
        description: layer.description ?? "",
        geometryType: layer.geometryType,
        kind: "geospatial",
        // The component takes the dataset's title/description from the
        // JSON Schema document itself.
        schema:
          layer.description === undefined
            ? { ...layer.schema, title: layer.title }
            : { ...layer.schema, description: layer.description, title: layer.title },
        title: layer.title,
      },
      remoteSchemaVersion: layer.schemaVersion,
      source: args.source,
    });
  },
  returns: v.object({ alreadyRunning: v.boolean(), runId: v.id("syncRuns") }),
});

export const statusInternal = internalQuery({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    const [binding, latestCheck] = await Promise.all([
      ctx.db
        .query("datasetBindings")
        .withIndex("by_source", (q) => q.eq("source", args.source))
        .first(),
      ctx.db
        .query("remoteSourceChecks")
        .withIndex("by_source", (q) => q.eq("source", args.source))
        .first(),
    ]);
    return statusOf(args.source, binding, latestCheck);
  },
  returns: statusValidator,
});
