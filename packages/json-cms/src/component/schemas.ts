import { ConvexError, v } from "convex/values";

import { geometryTypeValidator } from "../shared/geojson/validators.js";
import type { GeometryTypeArg } from "../shared/geojson/validators.js";
import { REFERENCE_KEYWORD } from "../shared/reference.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import {
  DELETE_BYTE_RESERVE,
  DELETE_ROW_BYTE_ESTIMATE,
  transactionReadRemaining,
} from "./internal/deleteBudget.js";
import { paginateEntriesBySchema } from "./internal/entryPages.js";
import { syncEntryReferences } from "./internal/entryWrites.js";
import {
  clampLimit,
  isCatalogVisibleToViewer,
  isVisibleToViewer,
  toPublicSchemaView,
} from "./internal/schemaViews.js";
import {
  assertDataWritable,
  boundWriteValidator,
  entryValidator,
  publicSchemaViewValidator,
  schemaValidator,
} from "./internal/shared.js";
import { MAP_TILE_ARCHIVE_FORMAT } from "./internal/tileArchive.js";
import { lineageValidator } from "./schema.js";

const SCHEMA_SIZE_LIMIT = 102_400; // 100 KB

// Schema queries

export const listSchemas = query({
  // Required limit (issue #128): the read is bounded to `limit` docs — full
  // schema docs are the heaviest rows in the component (up to 200 KB of
  // schema + uiSchema payload each), so an unbounded collect here was the
  // catalog's worst read amplification. See the list-read bounds note in
  // internal/schemaViews.ts on the filter-after-take window.
  args: { limit: v.number(), viewerId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db.query("schemas").order("desc").take(clampLimit(args.limit));
    return docs
      .filter((doc) => isCatalogVisibleToViewer(doc, args.viewerId))
      .map(toPublicSchemaView);
  },
  returns: v.array(publicSchemaViewValidator),
});

/** Number of top-level `properties` on a stored JSON schema — the datasets
 * browser's "N fields" badge. Mirrors the app's `fieldCount` helper so the
 * projection can replace the raw `schema` payload there (issue #53). */
function storedSchemaFieldCount(schemaJson: unknown): number {
  if (typeof schemaJson !== "object" || schemaJson === null || Array.isArray(schemaJson)) {
    return 0;
  }
  const properties = (schemaJson as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return 0;
  }
  return Object.keys(properties).length;
}

/**
 * List-page projection of `listSchemas` (issue #53): every field the
 * datasets browser, groups/collections pages, pickers, and the map workspace
 * read — but NOT `schema`/`uiSchema` (each up to the 100 KB
 * `SCHEMA_SIZE_LIMIT`, dead weight on pages that only show titles, counts,
 * and type tags). The only schema-derived value is `fieldCount`, computed
 * here so the browser card doesn't need the raw payload either. The Structure
 * tab and schema editor keep reading the full doc via `getSchema`.
 * `createdBy` (ADR 0007's authorship stamp) rides along so host list
 * surfaces can attribute datasets without the payloads.
 */
/**
 * The list-page projection shared by `listSchemaSummaries` (published view)
 * and `listDraftSchemaSummaries` (the opt-in drafts view) — one shape, so a
 * consumer can merge the two reads without a second type.
 */
function toSchemaSummary(doc: Doc<"schemas">) {
  return {
    _creationTime: doc._creationTime,
    _id: doc._id,
    boundingBox: doc.boundingBox,
    // Authorship rides the projection so list surfaces (the profile page's
    // per-creator listing, the browser's "by X" line) can show and group by
    // creator without pulling the heavy schema payloads. The host resolves
    // the opaque id to a display name via its own users mirror.
    createdBy: doc.createdBy,
    description: doc.description,
    entryCount: doc.entryCount,
    featureCount: doc.featureCount,
    fieldCount: storedSchemaFieldCount(doc.schema),
    geometryType: doc.geometryType,
    groupId: doc.groupId,
    kind: doc.kind,
    // The lifecycle state rides the projection (roadmap 5a, #99) so
    // consumers can tell an absent/published row from a draft one without
    // the payloads.
    lifecycle: doc.lifecycle,
    lineage: doc.lineage,
    mapTileArchiveBuiltVersion: doc.mapTileArchiveBuiltVersion,
    mapTileArchiveBytes: doc.mapTileArchiveBytes,
    // Issue #125's format gate, mirrored into the projection as a DERIVED
    // boolean rather than the raw format field: the TileArchiveManager is
    // app-level code that can't import this component, and a mirrored copy
    // of `MAP_TILE_ARCHIVE_FORMAT` that drifted low would schedule rebuilds
    // forever (every fresh install stamps a format the stale copy rejects).
    // Computing it here — against the same constant `getMapTileArchiveMeta`
    // gates on — keeps one authoritative comparison.
    mapTileArchiveFormatCurrent: doc.mapTileArchiveFormat === MAP_TILE_ARCHIVE_FORMAT,
    mapTileArchiveMaxZoom: doc.mapTileArchiveMaxZoom,
    // Deliberately NO `mapTileArchiveStorageId` (issue #131): the summary is
    // a public result, and a `_storage` id in it invites cross-dataset blob
    // mishandling downstream. An installed archive is provable from
    // `mapTileArchiveBuiltVersion` alone (set iff one ever installed).
    mapTileCacheVersion: doc.mapTileCacheVersion,
    // The published-visibility control rides the projection (stage 8, #104)
    // for the same reason: host list surfaces re-filtering or attributing
    // rows never need the heavy payloads to apply the identity rule.
    publishedVisibility: doc.publishedVisibility,
    // The edit policy rides too (issue #124): the datasets browser's lock
    // badges read the same light summary as every other card field.
    editPolicy: doc.editPolicy,
    source: doc.source,
    title: doc.title,
  };
}

const schemaSummaryValidator = schemaValidator
  .pick(
    "_creationTime",
    "_id",
    "boundingBox",
    "createdBy",
    "description",
    "editPolicy",
    "entryCount",
    "featureCount",
    "geometryType",
    "groupId",
    "kind",
    "lifecycle",
    "lineage",
    "mapTileArchiveBuiltVersion",
    "mapTileArchiveBytes",
    "mapTileArchiveMaxZoom",
    "mapTileCacheVersion",
    "publishedVisibility",
    "source",
    "title",
  )
  .extend({
    // `fieldCount` is computed from the heavy payload (never stored);
    // `mapTileArchiveFormatCurrent` is the derived issue #125 gate flag the
    // projection computes from the stored `mapTileArchiveFormat`.
    fieldCount: v.number(),
    mapTileArchiveFormatCurrent: v.boolean(),
  });

export const listSchemaSummaries = query({
  // Required limit (issue #128) — same bound as `listSchemas`; the summary
  // projection (#52/#53) keeps the RETURN light, and the take keeps the READ
  // (which still touches the full docs — Convex reads whole documents) bounded.
  args: { limit: v.number(), viewerId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db.query("schemas").order("desc").take(clampLimit(args.limit));
    return docs.filter((doc) => isCatalogVisibleToViewer(doc, args.viewerId)).map(toSchemaSummary);
  },
  returns: v.array(schemaSummaryValidator),
});

/**
 * The opt-in drafts view (roadmap 5a, #99): only datasets explicitly flagged
 * `lifecycle: "draft"`, same projection as `listSchemaSummaries`. The default
 * list reads exclude drafts server-side ("drafts are invisible to catalog
 * consumers", lifecycle §3), so this is the only component read that returns
 * them — the datasets browser's drafts toggle subscribes to it through its
 * exposeApi wrapper. Absent lifecycle reads as published (see
 * `isCatalogVisible`), so pre-field rows never appear here either.
 *
 * Since stage 8 (#104) it is also CREATOR-SCOPED: the caller's identity
 * (required `viewerId`, the host auth hook's return) decides whose drafts
 * come back — the pre-stage-8 all-users drafts enumeration was the widest
 * draft leak in the catalog surface.
 */
export const listDraftSchemaSummaries = query({
  // Required limit (issue #128) — same bound as its sibling reads.
  args: { limit: v.number(), viewerId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db.query("schemas").order("desc").take(clampLimit(args.limit));
    return docs
      .filter((doc) => doc.lifecycle === "draft" && isVisibleToViewer(doc, args.viewerId))
      .map(toSchemaSummary);
  },
  returns: v.array(schemaSummaryValidator),
});

export const getSchema = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.schemaId);
    return doc === null ? null : toPublicSchemaView(doc);
  },
  returns: v.union(v.null(), publicSchemaViewValidator),
});

/**
 * One dataset's entries, bounded — the HOST version-diff read (`versionRows`
 * in the app's versioning.ts): internal host flows (tag ingest, freeze diffs,
 * retention enforcement) must see every row of the datasets they operate on,
 * including author-restricted publish-frozen rows, so the read is
 * deliberately UNscoped. Public-in-component but UNEXPOSED (never in
 * exposeApi — the `setMapTileArchive`/`getImportSchemaId` pattern:
 * host-flow-only, unreachable by clients); the client-facing batch read
 * (`listEntriesForSchemas`) is the viewer-scoped one (stage 8, #104).
 */
export const listEntriesForSchemaBounded = query({
  args: { limit: v.number(), schemaId: v.id("schemas") },
  handler: async (ctx, args) =>
    ctx.db
      .query("entries")
      .withIndex("by_schema", (q) => q.eq("schemaId", args.schemaId))
      .take(args.limit),
  returns: v.array(entryValidator),
});

/**
 * One import status doc's schema id (stage 8, #104) — lets the host auth
 * policy scope `getImportStatus` (whose importId names no dataset directly)
 * with one read. Deliberately UNEXPOSED: host-flow-only.
 */
export const getImportSchemaId = query({
  args: { importId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("imports", args.importId);
    if (id === null) {
      return null;
    }
    const doc = await ctx.db.get(id);
    return doc === null ? null : doc.schemaId;
  },
  returns: v.union(v.null(), v.id("schemas")),
});

/**
 * The map a layer row belongs to (issue #124) — lets the host auth policy see
 * WHICH map a layer-targeted wrapper (`removeMapLayer` and siblings, whose
 * args carry only `layerId`) is mutating, so a per-map policy becomes
 * possible without reshaping the wrappers. Maps are shared catalog artifacts
 * today (no policy reads this yet — the recorded stage-8 boundary); the read
 * exists so the operation ARG is already honest when one lands. Tolerates a
 * `layerId` that isn't well-formed (the `getImportSchemaId` pattern — the
 * policy must never be what crashes a call). Deliberately UNEXPOSED:
 * host-flow-only, like every policy-seam read.
 */
export const getMapLayerMapId = query({
  args: { layerId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("mapLayers", args.layerId);
    if (id === null) {
      return null;
    }
    const doc = await ctx.db.get(id);
    return doc === null ? null : doc.mapId;
  },
  returns: v.union(v.null(), v.string()),
});

/**
 * Frozen versions (tags) of one bound dataset, newest freeze first — the
 * dataset page's "Versions" list. Only docs carrying `lineage` are in the
 * index, so ordinary datasets list nothing here.
 *
 * Required limit (issue #128) — same bound as its sibling reads: each row
 * maps through `toPublicSchemaView`, so a long chain re-reads full schema
 * payloads. Chains are keep-N retention-bounded in practice, so the honored
 * width is headroom, not a correctness cap.
 */
export const listSchemaVersions = query({
  args: { limit: v.number(), sourceSchemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const versions = await ctx.db
      .query("schemas")
      .withIndex("by_lineage_source", (q) => q.eq("lineage.sourceSchemaId", args.sourceSchemaId))
      .order("desc")
      .take(clampLimit(args.limit));
    return versions.map(toPublicSchemaView);
  },
  returns: v.array(publicSchemaViewValidator),
});

/**
 * The frozen version ingested from one snapshot ref, if any — the tag
 * ingest's idempotency check. Matches a ref already frozen under an older
 * live dataset too, so re-ingesting after the live dataset was re-created
 * can't duplicate versions of the same snapshot.
 */
export const getSchemaVersionBySnapshotRef = query({
  args: { snapshotRef: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("schemas")
      .withIndex("by_lineage_snapshotRef", (q) => q.eq("lineage.snapshotRef", args.snapshotRef))
      .first();
    return doc === null ? null : toPublicSchemaView(doc);
  },
  returns: v.union(v.null(), publicSchemaViewValidator),
});

/**
 * A fetchable URL for the original file this dataset was imported from
 * (retained through `startImport`'s `sourceFile`), or `null` when the
 * dataset has no retained source file or its blob is gone. Lets clients
 * re-download the exact uploaded bytes even after geometry has been
 * simplified on write.
 */
export const getSourceFileUrl = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc || schemaDoc.sourceFileStorageId === undefined) {
      return null;
    }
    return ctx.storage.getUrl(schemaDoc.sourceFileStorageId);
  },
  returns: v.union(v.null(), v.string()),
});

// Tile archive (issue #58)
//
// The per-dataset MVT/PMTiles rendering cache. The rebuild worker (part 3)
// snapshots `mapTileCacheVersion`, generates the archive from that exact
// data, uploads the blob, then installs it here. Correctness lives in the
// `expectedVersion` guard below, not in any client-side debounce: a rebuild
// that started against stale data self-discards instead of shadowing a
// newer dataset state.

/**
 * A fetchable URL for the dataset's current tile archive, plus the metadata
 * a client needs to decide between the tile path and the row path
 * (`version` currency check, byte size, max zoom). All fields absent/null
 * when the dataset has no installed archive (or its blob is gone, or the
 * installed archive predates the current `MAP_TILE_ARCHIVE_FORMAT` —
 * issue #125's invalidation: such archives were built by a builder whose
 * run-length dedupe could merge across tile-id gaps, so they read as
 * "row path only" until a rebuild replaces them) — read that as
 * "row path only".
 */
export const getMapTileArchiveMeta = query({
  args: { schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (
      !schemaDoc ||
      schemaDoc.mapTileArchiveStorageId === undefined ||
      schemaDoc.mapTileCacheVersion === undefined ||
      // Part 3's amendment: `version` is the version the archive was BUILT
      // from (`mapTileArchiveBuiltVersion`), not the live counter — every
      // consumer (the react hook doc, issue #61's stale-on-view trigger)
      // compares it against `schemaDoc.mapTileCacheVersion`. An archive
      // missing the built-version field can only predate this field (dev
      // installs from before the amendment); treat it as no archive rather
      // than serve an unanchored staleness check.
      schemaDoc.mapTileArchiveBuiltVersion === undefined ||
      // Issue #125's format gate: an archive whose format field is absent
      // (format 1) or behind the current constant was built by an older
      // builder and must not be served — the same self-healing shape as
      // the built-version check above. Null meta flips the dataset to the
      // row path and the OPFS pin prunes its copy; the rebuild fires
      // because this gate is mirrored into the summary projection
      // (`mapTileArchiveFormatCurrent`), which `isTileArchiveStale` reads
      // as stale — a format-gated row never waits for an edit.
      schemaDoc.mapTileArchiveFormat !== MAP_TILE_ARCHIVE_FORMAT
    ) {
      return null;
    }
    // `ctx.storage.getUrl` works in queries (same precedent as
    // `resolveGeometryOutput`/`getSourceFileUrl`); a `null` URL means the
    // blob was already deleted out from under the pointer — treat that as
    // no archive rather than handing the client a dead link.
    const url = await ctx.storage.getUrl(schemaDoc.mapTileArchiveStorageId);
    if (url === null) {
      return null;
    }
    // Deliberately NO `storageId` here (issue #131): clients decide between
    // the tile and row paths from `url`/`version` alone — a `_storage` id in
    // a public result invites cross-dataset blob mishandling downstream.
    return {
      bytes: schemaDoc.mapTileArchiveBytes,
      maxZoom: schemaDoc.mapTileArchiveMaxZoom,
      url,
      version: schemaDoc.mapTileArchiveBuiltVersion,
    };
  },
  returns: v.union(
    v.null(),
    v.object({
      bytes: v.optional(v.number()),
      maxZoom: v.optional(v.number()),
      url: v.string(),
      version: v.number(),
    }),
  ),
});

/**
 * Installs a freshly generated tile archive onto a schema, guarded by the
 * version snapshot the rebuild worker took BEFORE generating: if
 * `expectedVersion` no longer matches the schema's current
 * `mapTileCacheVersion`, edits landed while the archive was being built —
 * so the incoming blob is deleted and nothing is patched (a stale rebuild
 * self-discards, and the client's next staleness check will trigger a
 * rebuild against the newer version). On match, the superseded archive blob
 * is deleted (blobs are immutable; a new generation is a new blob) and all
 * six fields are patched atomically.
 *
 * Deliberately a PUBLIC component mutation, NOT exposed through `exposeApi`:
 * a component-internal function is invisible to the host app entirely (the
 * generated ComponentApi only carries public functions), and the rebuild
 * worker — app-level code (part 3) — reaches this through a thin
 * app-layer mutation wrapping `components.jsonCms.schemas.setMapTileArchive`.
 * Because `exposeApi` never re-exports it, no browser client has a path to
 * it — which is the property the issue's "internal" actually meant.
 */
export const setMapTileArchive = mutation({
  args: {
    bytes: v.number(),
    expectedVersion: v.number(),
    maxZoom: v.number(),
    schemaId: v.id("schemas"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (!schemaDoc) {
      // The dataset itself is gone — its archive blob is now unreferenced.
      await ctx.storage.delete(args.storageId);
      return;
    }
    // The current version reads as 0 only when ABSENT — a dataset that
    // predates these fields. A cleared dataset carries a monotonically
    // bumped version (issue #129), so a rebuild snapshotted before the
    // clear can never pass this guard again — the counter never returns to
    // a version it has already left.
    const currentVersion = schemaDoc.mapTileCacheVersion ?? 0;
    if (currentVersion !== args.expectedVersion) {
      // Stale rebuild: edits happened during generation. Discard the
      // incoming blob; leave the row (including any current archive)
      // untouched.
      await ctx.storage.delete(args.storageId);
      return;
    }

    const superseded = schemaDoc.mapTileArchiveStorageId;
    if (superseded !== undefined && superseded !== args.storageId) {
      await ctx.storage.delete(superseded);
    }
    // Patch all six fields: the three archive pointers plus
    // `mapTileArchiveBuiltVersion` (the snapshot this archive was built
    // from — equal to the current version here, which is what makes
    // `getMapTileArchiveMeta`'s `version` the staleness comparison
    // anchor), `mapTileArchiveFormat` (the layout generation this install
    // was written by — the issue #125 invalidation gate) and
    // `mapTileCacheVersion` explicitly so "an installed archive always
    // carries a version" holds even for a legacy absent-field row.
    await ctx.db.patch(args.schemaId, {
      mapTileArchiveBuiltVersion: args.expectedVersion,
      mapTileArchiveBytes: args.bytes,
      mapTileArchiveFormat: MAP_TILE_ARCHIVE_FORMAT,
      mapTileArchiveMaxZoom: args.maxZoom,
      mapTileArchiveStorageId: args.storageId,
      mapTileCacheVersion: args.expectedVersion,
    });
  },
});

// Schema mutations

/** Throws unless a `kind`/`geometryType` pair is a valid combination for a schema doc. */
function assertKindAndGeometryType(
  kind: "standard" | "geospatial" | undefined,
  geometryType: GeometryTypeArg | undefined,
): void {
  if (kind === "geospatial" && geometryType === undefined) {
    throw new ConvexError("A geospatial dataset must specify a geometryType.");
  }
  if (kind !== "geospatial" && geometryType !== undefined) {
    throw new ConvexError("A standard dataset cannot specify a geometryType.");
  }
}

/** Throws unless `simplifyGeometry` is only requested for a geospatial dataset — a standard dataset has no geometry to simplify. */
function assertSimplifyGeometryApplies(
  kind: "standard" | "geospatial" | undefined,
  simplifyGeometry: boolean | undefined,
): void {
  if (simplifyGeometry !== undefined && kind !== "geospatial") {
    throw new ConvexError("Only a geospatial dataset can simplify geometry.");
  }
}

export const createSchema = mutation({
  args: {
    // The host's identity string for the actor creating this dataset —
    // stored on the doc as `createdBy` (see the field's doc on the
    // `schemas` table). The exposeApi wrapper fills this from its `auth`
    // hook's return value; clients can't set it directly (the wrapper's
    // validators are exact and it builds the component call itself).
    // Optional so host flows that create datasets without an acting user
    // (bound-sync re-creates, tag ingest) can omit it.
    actorId: v.optional(v.string()),
    geometryType: v.optional(geometryTypeValidator),
    kind: v.optional(v.union(v.literal("standard"), v.literal("geospatial"))),
    schema: v.any(),
    // Marks the dataset as a read-only projection of a connected external
    // source — see the `source` field's doc on the `schemas` table. Absent
    // for ordinary user-created datasets.
    source: v.optional(v.object({ name: v.string() })),
    // Marks the dataset as a frozen point-in-time version — of a bound live
    // dataset (the tag-ingest flow) or a materialized publish (roadmap 5b).
    // See the `lineage` field's doc on the `schemas` table and the shared
    // `lineageValidator` in schema.ts. Written by host flows, never by
    // user-facing creates.
    lineage: v.optional(lineageValidator),
    // Catalog lifecycle state (roadmap 5a, #99) — see the `lifecycle` field's
    // doc on the `schemas` table. Host-flow-only like `source`/`lineage`: the
    // exposeApi wrapper deliberately omits it, so no client path can create a
    // draft. Absent (every caller today, including the host's materialized
    // version datasets) reads as published, so this arg changes nothing until
    // a future host flow (5b's publish) sets it.
    lifecycle: v.optional(v.union(v.literal("draft"), v.literal("published"))),
    // Published-visibility control (stage 8, #104) — see the field's doc on
    // the `schemas` table. Host-flow-only like `lifecycle` (the wrapper
    // omits it): the publish freeze passes the draft's value through so the
    // frozen row inherits the authoring-time choice.
    publishedVisibility: v.optional(v.union(v.literal("author"), v.literal("everyone"))),
    // Normalize every geometry coordinate to GEOMETRY_SIMPLIFY_DECIMAL_PLACES
    // on write — see `simplifyGeometryPayload` below. Geospatial-only.
    simplifyGeometry: v.optional(v.boolean()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // The validator is `v.any()`, so a null/non-object `schema` reaches here —
    // read it defensively (issue #129): a bare `args.schema.title` threw a raw
    // TypeError instead of a client-facing ConvexError.
    if (typeof args.schema !== "object" || args.schema === null || Array.isArray(args.schema)) {
      throw new ConvexError("Schema must be an object with a non-empty 'title' property.");
    }
    if (!args.schema.title) {
      throw new ConvexError("Schema must have a non-empty 'title' property");
    }

    assertKindAndGeometryType(args.kind, args.geometryType);
    assertSimplifyGeometryApplies(args.kind, args.simplifyGeometry);

    const schemaStr = JSON.stringify(args.schema);
    if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
      throw new ConvexError("Schema exceeds the 100 KB size limit.");
    }

    if (args.uiSchema !== undefined) {
      const uiSchemaStr = JSON.stringify(args.uiSchema);
      if (uiSchemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("UI Schema exceeds the 100 KB size limit.");
      }
    }

    const schemaId = await ctx.db.insert("schemas", {
      boundingBox: undefined,
      createdBy: args.actorId,
      description: args.schema.description,
      entryCount: 0,
      featureCount: args.kind === "geospatial" ? 0 : undefined,
      geometryType: args.geometryType,
      kind: args.kind,
      lifecycle: args.lifecycle,
      lineage: args.lineage,
      publishedVisibility: args.publishedVisibility,
      schema: args.schema,
      simplifyGeometry: args.simplifyGeometry,
      source: args.source,
      title: args.schema.title,
      uiSchema: args.uiSchema,
    });

    return schemaId;
  },
  returns: v.id("schemas"),
});

/**
 * Sets (or resets) one dataset's published-visibility control (stage 8,
 * #104): `"author"` narrows catalog reads to the row's creator, `"everyone"`
 * restores the default. Public-in-component but deliberately UNEXPOSED — no
 * exposeApi wrapper carries it, so the only caller is the host's
 * `schemas.setVisibility` mutation, which resolves the caller's identity at
 * the choke point and enforces the ownership check (only the row's creator
 * may flip its visibility). Deliberately NOT part of `updateSchema`: the
 * control is a sharing decision, not a metadata edit, and it must never be
 * settable through the generic wrapper path.
 */
export const setSchemaVisibility = mutation({
  args: {
    // The host's ownership check rides on this being reachable only through
    // its own gated mutation; the component-side existence check stays.
    publishedVisibility: v.union(v.literal("author"), v.literal("everyone")),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }
    await ctx.db.patch(args.schemaId, { publishedVisibility: args.publishedVisibility });
  },
  returns: v.null(),
});

/**
 * Sets (or resets) one dataset's edit policy (issue #124, ADR 0010):
 * `"locked"` narrows every write to the row's creator, `"open"` restores the
 * trusted-collaborator default. Public-in-component but deliberately
 * UNEXPOSED — no exposeApi wrapper carries it, so the only caller is the
 * host's `schemas.setEditPolicy` mutation, which resolves the caller's
 * identity at the choke point and enforces the ownership check (only the
 * row's creator may flip its policy — locking is itself a write the policy
 * gates). The `setSchemaVisibility` twin: a sharing decision, never part of
 * the generic `updateSchema` metadata path.
 */
export const setEditPolicy = mutation({
  args: {
    editPolicy: v.union(v.literal("open"), v.literal("locked")),
    // The host's ownership check rides on this being reachable only through
    // its own gated mutation; the component-side existence check stays.
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }
    await ctx.db.patch(args.schemaId, { editPolicy: args.editPolicy });
  },
  returns: v.null(),
});

/**
 * Throws unless `schema` is a JSON-Schema-shaped record carrying a non-empty
 * `title` (issue #129: a null schema used to surface as a raw TypeError
 * because the validator is `v.any()`).
 */
function assertValidSchemaPayload(
  schemaPayload: unknown,
): asserts schemaPayload is Record<string, unknown> {
  if (typeof schemaPayload !== "object" || schemaPayload === null || Array.isArray(schemaPayload)) {
    throw new ConvexError("Schema must be an object with a non-empty 'title' property.");
  }
  if (!("title" in schemaPayload) || !schemaPayload.title) {
    throw new ConvexError("Schema must have a non-empty 'title' property");
  }
}

/**
 * Validates `updateSchema`'s args and folds them into the patch to apply.
 * `structureChanged` marks a schema/uiSchema change (as opposed to
 * metadata-only edits, which stay allowed on read-only datasets — the
 * recorded behavior `bound-write.test.ts` pins). Extracted from the handler
 * so its branch count stays manageable.
 *
 * `uiSchema: null` EXPLICITLY clears the stored uiSchema (the
 * `updateEntry` geometry-null precedent): patching `undefined` removes the
 * field, while omitting the arg leaves it untouched — the distinction the
 * edit form needs so clearing the editor actually saves (issue #135,
 * defect 4: `undefined` meant "leave it", so the clear was silently dropped).
 */
function buildSchemaUpdatePatch(args: {
  description?: string;
  schema?: unknown;
  title?: string;
  uiSchema?: unknown;
}): { patch: Record<string, unknown>; structureChanged: boolean } {
  const patch: Record<string, unknown> = {};
  let structureChanged = false;

  const nextSchema = args.schema;
  if (nextSchema === undefined) {
    if (args.title !== undefined) {
      patch.title = args.title;
    }
    if (args.description !== undefined) {
      patch.description = args.description;
    }
  } else {
    assertValidSchemaPayload(nextSchema);
    const schemaStr = JSON.stringify(nextSchema);
    if (schemaStr.length > SCHEMA_SIZE_LIMIT) {
      throw new ConvexError("Schema exceeds the 100 KB size limit.");
    }
    patch.schema = nextSchema;
    patch.title = nextSchema.title;
    patch.description = "description" in nextSchema ? nextSchema.description : undefined;
    structureChanged = true;
  }

  if (args.uiSchema !== undefined) {
    if (args.uiSchema === null) {
      patch.uiSchema = undefined;
      structureChanged = true;
    } else {
      const uiSchemaStr = JSON.stringify(args.uiSchema);
      if (uiSchemaStr.length > SCHEMA_SIZE_LIMIT) {
        throw new ConvexError("UI Schema exceeds the 100 KB size limit.");
      }
      patch.uiSchema = args.uiSchema;
      structureChanged = true;
    }
  }

  return { patch, structureChanged };
}

export const updateSchema = mutation({
  args: {
    // Host-only bound-dataset write attestation — see `assertDataWritable`.
    // Carried by host flows that legitimately rewrite a bound dataset's
    // structure (the sync engine's schema migration); never accepted from
    // the exposeApi wrapper (its exact validators omit it).
    boundWrite: boundWriteValidator,
    description: v.optional(v.string()),
    schema: v.optional(v.any()),
    schemaId: v.id("schemas"),
    title: v.optional(v.string()),
    uiSchema: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }

    const { patch, structureChanged } = buildSchemaUpdatePatch(args);

    // A structure change on a frozen (`lineage`) or bound (`source`) dataset
    // is a write to its locked definition, so it goes through the same
    // read-only gate as data (issue #129: this mutation was the one
    // data-adjacent path that skipped `assertDataWritable`).
    if (structureChanged) {
      assertDataWritable(existing, args.boundWrite);
    }

    await ctx.db.patch(args.schemaId, patch);

    // The `references` table mirrors each entry's outgoing pointers as
    // derived from the schema's `x-reference` fields — a structure change
    // can re-write that derivation, so the mirror re-syncs (issue #129:
    // reverse lookups went stale after every x-reference edit). Scheduled
    // as a batched re-index so a large dataset never blocks the edit; the
    // cheap keyword guard skips the walk entirely when neither the old nor
    // the new schema mentions a reference field.
    if (args.schema !== undefined && referenceFieldsMayHaveChanged(existing.schema, args.schema)) {
      await ctx.scheduler.runAfter(0, internal.schemas.resyncSchemaReferencesStep, {
        cursor: null,
        schemaId: args.schemaId,
      });
    }
  },
});

/** Rows per `resyncSchemaReferencesStep` pass — entries are thin-to-moderate; the width shrinks with the transaction's remaining read budget (the delete drain's estimate). */
const REFERENCE_RESYNC_BATCH = 100;

/**
 * One budget-bounded pass of the scheduled references re-index
 * (`updateSchema`): re-derives every reference row for the next batch of the
 * dataset's entries against the JUST-UPDATED schema, then reschedules itself
 * until the index is exhausted. The schema doc is re-read each pass so a
 * schema replaced again mid-resync resyncs against the newest definition.
 */
export const resyncSchemaReferencesStep = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), schemaId: v.id("schemas") },
  handler: async (ctx, args) => {
    const schemaDoc = await ctx.db.get(args.schemaId);
    if (schemaDoc === null) {
      return; // The dataset went away mid-resync — nothing to re-derive.
    }
    const remaining = await transactionReadRemaining(ctx);
    if (remaining !== null && remaining < DELETE_BYTE_RESERVE) {
      // Out of budget — hand off with the SAME cursor; the fresh transaction
      // resumes exactly where this one stopped.
      await ctx.scheduler.runAfter(0, internal.schemas.resyncSchemaReferencesStep, {
        cursor: args.cursor,
        schemaId: args.schemaId,
      });
      return;
    }
    const width =
        remaining === null
          ? REFERENCE_RESYNC_BATCH
          : Math.max(
              1,
              Math.min(
                REFERENCE_RESYNC_BATCH,
                Math.floor((remaining - DELETE_BYTE_RESERVE) / DELETE_ROW_BYTE_ESTIMATE),
              ),
            ),
      { continueCursor, isDone, page } = await paginateEntriesBySchema(
        ctx,
        args.schemaId,
        args.cursor,
        width,
        "asc",
      );
    await Promise.all(
      page.map(
        async (entry) =>
          await syncEntryReferences(ctx, entry._id, args.schemaId, schemaDoc, entry.data),
      ),
    );
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.schemas.resyncSchemaReferencesStep, {
        cursor: continueCursor,
        schemaId: args.schemaId,
      });
    }
  },
  returns: v.null(),
});

/**
 * Whether editing the schema COULD have changed the reference-field set:
 * true when either the stored or the incoming schema mentions the
 * `x-reference` keyword at all. Reference fields are top-level properties
 * annotated with that keyword (see ../shared/reference.ts), so two schemas
 * that never mention it derive exactly the same (empty) reference set — the
 * re-index walk can be skipped outright.
 */
function referenceFieldsMayHaveChanged(oldSchema: unknown, nextSchema: unknown): boolean {
  return (
    JSON.stringify(oldSchema).includes(REFERENCE_KEYWORD) ||
    JSON.stringify(nextSchema).includes(REFERENCE_KEYWORD)
  );
}

/**
 * Flips a dataset's catalog lifecycle between "draft" and "published"
 * (roadmap 5a, #99). Public-in-component but deliberately UNEXPOSED — the
 * `setSchemaVisibility` pattern: the only caller is the host, which resolves
 * identity at its own choke point (the import flow's
 * `schemas.markImportComplete` — issue #129's draft-until-complete rule).
 * Never part of `updateSchema`, whose wrapper path must stay unable to touch
 * lifecycle at all.
 */
export const setSchemaLifecycle = mutation({
  args: {
    lifecycle: v.union(v.literal("draft"), v.literal("published")),
    schemaId: v.id("schemas"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.schemaId);
    if (!existing) {
      throw new ConvexError("Schema not found");
    }
    // A bound dataset's lifecycle belongs to its host sync/ingest flow —
    // this mutation serves the ordinary import lifecycle only.
    if (existing.source !== undefined) {
      throw new ConvexError("A bound dataset's lifecycle is managed by its source sync flow.");
    }
    await ctx.db.patch(args.schemaId, { lifecycle: args.lifecycle });
  },
  returns: v.null(),
});
