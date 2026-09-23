import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import type { CommitOp } from "./sources";

/**
 * Reusable frozen-version machinery (docs/data-platform-roadmap.md §3 0.3):
 * freezing a dataset state into an immutable version dataset, keep-N
 * retention with pinning, and the sequential version delta
 * (docs/bound-datasets-design.md §6–§7). Extracted from the tag path
 * (app/convex/tags.ts) with no behavior change — tag ingest is one caller;
 * the catalog lifecycle's materialized publish and versioned consumption
 * call these same functions instead of reinventing them
 * (docs/catalog-lifecycle-design.md §8.2).
 *
 * The cores take their inputs directly — (sourceSchemaId, ref, label) to
 * freeze, (sourceSchemaId, keep, pinnedRefs) to enforce retention — so the
 * host keeps its own policy store (today the tag path's `datasetBindings`
 * row) and passes the resolved values in. Invariants, unchanged from the
 * tag path:
 *
 * - A ref never freezes twice: the freeze re-checks `lineage.snapshotRef`
 *   inside its transaction, and the lookup is global — a ref stays frozen
 *   even across a re-bind to a recreated live dataset.
 * - Retention keeps the newest N unpinned versions; pinned refs never
 *   auto-retire; a version without a snapshotRef (or without lineage at
 *   all) counts as unpinned.
 * - A source's first version records no delta (nothing to diff against).
 * - Every retirement goes through the component's read-only gate with the
 *   host's `boundWrite` attestation; freeze attests the import with the
 *   calling flow's own attestation string.
 */

/** Unpinned versions kept per source when no explicit keep-N is set. */
export const DEFAULT_KEEP_VERSIONS = 10;

/** The component's validator for one commit-ops entry — the delta ops shape. */
export const commitOpValidator = v.object({
  entryKey: v.string(),
  fields: v.array(
    v.object({ after: v.optional(v.any()), before: v.optional(v.any()), name: v.string() }),
  ),
  geometryChanged: v.boolean(),
  op: v.union(v.literal("add"), v.literal("delete"), v.literal("update")),
});

/**
 * The slice of a component version doc the selection cores read —
 * structural on purpose, so tests build plain objects and the component's
 * richer docs drop right in.
 */
export type FrozenVersion = {
  _id: string;
  lineage?: {
    frozenAt: number;
    snapshotRef?: string;
  };
};

/** One light {key, data} version row — the diff's unit. */
export type VersionRow = { data: Record<string, unknown>; key: string };

// ---------------------------------------------------------------------------
// Pure selection cores (unit-tested in versioning.test.ts) — the retention
// and previous-version decisions, separated from the component reads and
// deletes they drive.
// ---------------------------------------------------------------------------

/**
 * Which versions retire under the retention policy: the newest `keep`
 * unpinned versions survive, everything older retires. Pinned refs are
 * exempt; a version without a snapshotRef (or without lineage at all)
 * counts as unpinned, with its freeze time read as 0 (oldest).
 */
export function versionsToRetire(
  versions: FrozenVersion[],
  keep: number,
  pinnedRefs: readonly string[],
): Array<{ frozenAt: number; id: string }> {
  const pinned = new Set(pinnedRefs);
  const unpinnedNewestFirst = versions
    .filter((version) => {
      if (version.lineage === undefined) {
        return true;
      }
      const ref = version.lineage.snapshotRef;
      return ref === undefined || !pinned.has(ref);
    })
    .map((version) => ({
      frozenAt: version.lineage !== undefined ? version.lineage.frozenAt : 0,
      id: version._id,
    }))
    // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; `.toSorted()` isn't in the lib app/convex typechecks against.
    .sort((a, b) => b.frozenAt - a.frozenAt);
  return unpinnedNewestFirst.slice(keep);
}

/**
 * The version a fresh freeze diffs against: the newest OTHER version of the
 * same source frozen at or before the target's freeze time. None (the
 * source's first version) → undefined.
 */
export function previousVersionOf(
  versions: FrozenVersion[],
  toSchemaId: string,
  targetFrozenAt: number,
): { frozenAt: number; id: string; ref?: string } | undefined {
  const candidates = versions
    .filter(
      (version) =>
        version._id !== toSchemaId &&
        version.lineage !== undefined &&
        version.lineage.frozenAt <= targetFrozenAt,
    )
    .map((version) => ({
      frozenAt: version.lineage !== undefined ? version.lineage.frozenAt : 0,
      id: version._id,
      ref: version.lineage !== undefined ? version.lineage.snapshotRef : undefined,
    }))
    // oxlint-disable-next-line unicorn/no-array-sort -- freshly mapped throwaway array; `.toSorted()` isn't in the lib app/convex typechecks against.
    .sort((a, b) => b.frozenAt - a.frozenAt);
  return candidates[0];
}

/** The natural display key of a version entry (the diff's join key). */
export function naturalKeyOf(data: Record<string, unknown>): string | undefined {
  if (typeof data.label === "string") {
    return data.label;
  }
  if (typeof data.name === "string") {
    return data.name;
  }
  return undefined;
}

const VERSION_DIFF_LIMIT = 2000;

/** Reads one version's entries as light {key, data} rows, bounded. */
export async function versionRows(
  ctx: { runQuery: QueryCtx["runQuery"] },
  schemaId: string,
): Promise<VersionRow[]> {
  const entries = await ctx.runQuery(components.jsonCms.lib.listEntriesForSchemas, {
    limit: VERSION_DIFF_LIMIT,
    schemaIds: [schemaId],
  });
  return entries.flatMap((entry) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listEntriesForSchemas returns untyped rows; the guards right below enforce the shape at runtime.
    const data = entry.data as Record<string, unknown> | null;
    if (data === null || typeof data !== "object") {
      return [];
    }
    const key = naturalKeyOf(data) ?? entry._id;
    return [{ data, key }];
  });
}

/**
 * Diffs two versions into the commits' ops shape — the same record the
 * ingest stores sequentially (tagDeltas) and the compare view computes for
 * arbitrary pairs. Deletes carry the before-state's fields so the overlay
 * can still show what a removal took away.
 */
export function diffVersionRows(before: VersionRow[], after: VersionRow[]): CommitOp[] {
  const beforeByKey = new Map(before.map((row) => [row.key, row.data])),
    afterByKey = new Map(after.map((row) => [row.key, row.data])),
    ops: CommitOp[] = [];
  const names = new Set<string>();
  for (const data of beforeByKey.values()) {
    for (const name of Object.keys(data)) {
      names.add(name);
    }
  }
  for (const data of afterByKey.values()) {
    for (const name of Object.keys(data)) {
      names.add(name);
    }
  }
  for (const [key, afterData] of afterByKey) {
    const beforeData = beforeByKey.get(key);
    if (beforeData === undefined) {
      ops.push({
        entryKey: key,
        fields: [...names]
          .filter((name) => afterData[name] !== undefined)
          .map((name) => ({
            after: afterData[name],
            name,
          })),
        geometryChanged: true,
        op: "add",
      });
      continue;
    }
    const fields = [...names]
      .filter((name) => JSON.stringify(beforeData[name]) !== JSON.stringify(afterData[name]))
      .map((name) => ({ after: afterData[name], before: beforeData[name], name }));
    const geometryChanged = fields.some((field) => field.name === "lat" || field.name === "lng");
    if (fields.length > 0) {
      ops.push({ entryKey: key, fields, geometryChanged, op: "update" });
    }
  }
  for (const [key, beforeData] of beforeByKey) {
    if (!afterByKey.has(key)) {
      ops.push({
        entryKey: key,
        fields: [...names]
          .filter((name) => beforeData[name] !== undefined)
          .map((name) => ({ before: beforeData[name], name })),
        geometryChanged: false,
        op: "delete",
      });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// The Convex cores. Thin over the pure decisions above: reads go through the
// component's own queries, writes through its read-only gate.
// ---------------------------------------------------------------------------

/**
 * Freezes one version of a source dataset: creates the version dataset (the
 * source's schema shape + read-only `source` marker + `lineage`), files it
 * into the same collections, and starts the import workflow over the
 * uploaded chunks. The by-ref re-check inside this transaction keeps a
 * concurrent double freeze from forking versions. `boundWrite` names the
 * calling flow (e.g. "tag-ingest") for the component's write gate.
 */
export const freezeVersion = internalMutation({
  args: {
    boundWrite: v.string(),
    chunkStorageIds: v.array(v.string()),
    label: v.string(),
    ref: v.string(),
    sourceSchemaId: v.string(),
    total: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.runQuery(components.jsonCms.lib.getSchemaVersionBySnapshotRef, {
      snapshotRef: args.ref,
    });
    if (existing !== null) {
      return { alreadyFrozen: true, importId: undefined, schemaId: existing._id };
    }
    const live = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: args.sourceSchemaId,
    });
    if (live === null) {
      throw new ConvexError("The bound live dataset no longer exists — sync and retry.");
    }
    const frozenAt = Date.now(),
      // The version's description rides on the schema object (createSchema
      // reads it from there); the title stays the source dataset's. The
      // wording is the tag path's (a frozen snapshot) — the machinery's
      // first caller.
      versionSchema = {
        ...live.schema,
        description: `Frozen snapshot "${args.label}" of ${live.title} — a point-in-time copy, read-only here.`,
      },
      schemaId = await ctx.runMutation(components.jsonCms.lib.createSchema, {
        geometryType: live.geometryType,
        kind: live.kind,
        lineage: {
          frozenAt,
          snapshotRef: args.ref,
          sourceSchemaId: args.sourceSchemaId,
          versionLabel: args.label,
        },
        schema: versionSchema,
        source: live.source,
      });
    const collections = await ctx.runQuery(components.jsonCms.lib.listCollectionsBySchema, {
      schemaId: args.sourceSchemaId,
    });
    for (const collection of collections) {
      // oxlint-disable-next-line no-await-in-loop -- one membership write per collection, ordered and trivial.
      await ctx.runMutation(components.jsonCms.lib.addSchemaToCollection, {
        collectionId: collection._id,
        schemaId,
      });
    }
    // An empty freeze still gets an import doc — zero chunks complete
    // immediately, and status reads uniformly for every version. The
    // `boundWrite` attestation marks this as the calling flow (the
    // component's read-only gate requires it on a lineage-marked schema).
    const importId = await ctx.runMutation(components.jsonCms.lib.startImport, {
      boundWrite: args.boundWrite,
      schemaId,
      storageIds: args.chunkStorageIds,
      total: args.total,
    });
    return { alreadyFrozen: false, importId, schemaId };
  },
  returns: v.object({
    alreadyFrozen: v.boolean(),
    importId: v.optional(v.string()),
    schemaId: v.string(),
  }),
});

/**
 * The retention policy: keep the newest N unpinned frozen versions of one
 * source; pinned refs are exempt. Callers resolve their own policy store
 * into (keep, pinnedRefs) and call this after every freeze so version
 * storage stays bounded no matter how often versions accumulate.
 */
export const enforceRetention = internalMutation({
  args: {
    keep: v.number(),
    pinnedRefs: v.array(v.string()),
    sourceSchemaId: v.string(),
  },
  handler: async (ctx, args) => {
    const versions = await ctx.runQuery(components.jsonCms.lib.listSchemaVersions, {
      sourceSchemaId: args.sourceSchemaId,
    });
    const retired = versionsToRetire(versions, args.keep, args.pinnedRefs);
    for (const version of retired) {
      // oxlint-disable-next-line no-await-in-loop -- ordered retirements under the write budget.
      await ctx.runMutation(components.jsonCms.lib.deleteSchema, {
        boundWrite: "retire",
        schemaId: version.id,
      });
    }
    return retired.length;
  },
  returns: v.number(),
});

/**
 * Records the sequential delta between a freshly frozen version and the
 * previous one (newest version of the same source frozen before it) into
 * the host's `tagDeltas` table — the name is the tag path's, which
 * introduced the table; it is the app's sequential version-delta record.
 * No previous version → no delta (the first version has nothing to diff
 * against).
 */
export const recordVersionDelta = internalMutation({
  args: {
    sourceSchemaId: v.string(),
    toSchemaId: v.string(),
    toRef: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(components.jsonCms.lib.getSchema, {
      schemaId: args.toSchemaId,
    });
    if (target === null || target.lineage === undefined) {
      return;
    }
    const versions = await ctx.runQuery(components.jsonCms.lib.listSchemaVersions, {
      sourceSchemaId: args.sourceSchemaId,
    });
    const previous = previousVersionOf(versions, args.toSchemaId, target.lineage.frozenAt);
    if (previous === undefined) {
      return;
    }
    const [before, after] = await Promise.all([
      versionRows(ctx, previous.id),
      versionRows(ctx, args.toSchemaId),
    ]);
    await ctx.db.insert("tagDeltas", {
      at: Date.now(),
      fromRef: previous.ref,
      ops: diffVersionRows(before, after),
      sourceSchemaId: args.sourceSchemaId,
      toRef: args.toRef,
    });
  },
  returns: v.null(),
});
