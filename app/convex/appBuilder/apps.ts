import { ConvexError, v } from "convex/values";

import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { auth } from "../auth";
import {
  appContentValidator,
  appPages,
  APP_LIMITS,
  sharingValidator,
  widgetDatasetIds,
  type AppPage,
  type Widget,
} from "./validators";

/**
 * The app builder's backend (docs/app-builder.md): a self-contained module —
 * its own table (`./tables.ts`), validators, and functions under
 * `api.appBuilder.apps.*` — that only READS the rest of the system (the
 * json-cms component's schema docs for the visibility check, the `users`
 * mirror for the owner's display name). Nothing else in the backend imports
 * it, so deleting the directory plus its one schema line removes the feature.
 *
 * Access model:
 * - Every call rides the app-wide sign-in gate (`auth(ctx)`).
 * - Writes answer only to the app's creator (`createdBy`).
 * - Reads: the creator always; anyone signed in when `sharing === "link"`
 *   (the share URL) or when the app is a seeded example (`example`, see
 *   examples.ts — owned by no user, so nobody edits it; everyone can copy
 *   it). Everyone else gets `null` — indistinguishable from a missing app,
 *   so an id's existence never leaks.
 * - An app stores dataset REFERENCES, never data or grants: every viewer's
 *   widget reads go through the normal dataset APIs and their visibility
 *   rules, so sharing an app never widens who can see a dataset.
 */

/** Display bound for the creator's app list. */
const MAX_APPS = 200;

/** Whether a signed-in caller may open an app (its share URL). */
function canRead(app: Doc<"apps">, actorId: string): boolean {
  return app.createdBy === actorId || app.sharing === "link" || app.example === true;
}

/** The page a brand-new app starts with. */
function firstPage(): AppPage {
  return { id: "page-1", layout: "contained", title: "Page 1", widgets: [] };
}

/** The id from a URL, or null when it isn't an `apps` id at all (share links are user-typed). */
function normalizeAppId(ctx: QueryCtx, appId: string): Id<"apps"> | null {
  return ctx.db.normalizeId("apps", appId);
}

async function appForWrite(ctx: MutationCtx, appId: string): Promise<Doc<"apps">> {
  const actorId = await auth(ctx),
    id = normalizeAppId(ctx, appId),
    app = id === null ? null : await ctx.db.get("apps", id);
  if (app === null || app.createdBy !== actorId) {
    throw new ConvexError("App not found.");
  }
  return app;
}

function assertTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new ConvexError("Give the app a title.");
  }
  if (trimmed.length > APP_LIMITS.title) {
    throw new ConvexError(`Keep the title under ${APP_LIMITS.title} characters.`);
  }
  return trimmed;
}

function cleanDescription(description: string | undefined): string | undefined {
  if (description === undefined) {
    return undefined;
  }
  const trimmed = description.trim();
  if (trimmed.length > APP_LIMITS.description) {
    throw new ConvexError(`Keep the description under ${APP_LIMITS.description} characters.`);
  }
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The catalog visibility rule (stage 8's D2, the projects.ts precedent) for
 * one dataset id: a draft or author-only row is visible to its creator only.
 * A malformed or unknown id is simply not visible.
 */
async function datasetVisibleTo(ctx: MutationCtx, schemaId: string, actorId: string) {
  let doc;
  try {
    doc = await ctx.runQuery(components.jsonCms.schemas.getSchema, { schemaId });
  } catch {
    return false;
  }
  if (doc === null) {
    return false;
  }
  if (doc.lifecycle === "draft" || doc.publishedVisibility === "author") {
    return doc.createdBy === actorId;
  }
  return true;
}

function assertInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConvexError(`${label} must be a whole number from ${min} to ${max}.`);
  }
}

/** Per-kind bounds beyond what the validator's shape checks. */
function assertWidgetBounds(widget: Widget) {
  if (widget.kind === "text" && widget.body.length > APP_LIMITS.text) {
    throw new ConvexError(`Keep text blocks under ${APP_LIMITS.text} characters.`);
  }
  if (widget.kind === "map" && widget.datasetIds.length > APP_LIMITS.mapDatasets) {
    throw new ConvexError(`A map shows at most ${APP_LIMITS.mapDatasets} datasets.`);
  }
  if (widget.kind === "table" && widget.columns.length > APP_LIMITS.tableColumns) {
    throw new ConvexError(`A table shows at most ${APP_LIMITS.tableColumns} columns.`);
  }
  if (widget.kind === "chart") {
    assertInteger(widget.limit, 1, 50, "A chart's group limit");
  }
}

function assertWidget(widget: Widget, sources: ReadonlySet<string>) {
  assertInteger(widget.w, 1, APP_LIMITS.columns, "A widget's width");
  assertInteger(widget.h, 1, APP_LIMITS.maxHeight, "A widget's height");
  if (widget.title !== undefined && widget.title.length > APP_LIMITS.title) {
    throw new ConvexError(`Keep widget titles under ${APP_LIMITS.title} characters.`);
  }
  assertWidgetBounds(widget);
  if (widgetDatasetIds(widget).some((id) => !sources.has(id))) {
    throw new ConvexError("A widget uses a dataset that isn't in this app — add it first.");
  }
}

function assertPage(page: AppPage) {
  const title = page.title.trim();
  if (title === "" || title.length > APP_LIMITS.pageTitle) {
    throw new ConvexError(`Give every page a title of up to ${APP_LIMITS.pageTitle} characters.`);
  }
  if (page.widgets.length > APP_LIMITS.widgets) {
    throw new ConvexError(`A page holds at most ${APP_LIMITS.widgets} widgets.`);
  }
}

function assertUnique(ids: readonly string[], message: string) {
  if (new Set(ids).size !== ids.length) {
    throw new ConvexError(message);
  }
}

/**
 * Shape rules the validators can't express: bounds, unique ids (pages, and
 * widgets across the whole app), and dataset references closed over the
 * app's sources.
 */
function assertContentShape(datasetIds: string[], pages: AppPage[]) {
  if (datasetIds.length > APP_LIMITS.datasets) {
    throw new ConvexError(`An app holds at most ${APP_LIMITS.datasets} datasets.`);
  }
  assertUnique(datasetIds, "A dataset is listed twice.");
  if (pages.length === 0 || pages.length > APP_LIMITS.pages) {
    throw new ConvexError(`An app has 1 to ${APP_LIMITS.pages} pages.`);
  }
  assertUnique(
    pages.map((page) => page.id),
    "Two pages share an id.",
  );
  const widgets = pages.flatMap((page) => page.widgets);
  if (widgets.length > APP_LIMITS.totalWidgets) {
    throw new ConvexError(`An app holds at most ${APP_LIMITS.totalWidgets} widgets in all.`);
  }
  assertUnique(
    widgets.map((widget) => widget.id),
    "Two widgets share an id.",
  );
  const sources = new Set(datasetIds);
  for (const page of pages) {
    assertPage(page);
  }
  for (const widget of widgets) {
    assertWidget(widget, sources);
  }
}

/** A widget list with every reference outside `kept` dropped (maps lose the layer; others go). */
function keepReferenced(widgets: readonly Widget[], kept: ReadonlySet<string>): Widget[] {
  return widgets.flatMap((widget): Widget[] => {
    if (widget.kind === "map") {
      return [{ ...widget, datasetIds: widget.datasetIds.filter((d) => kept.has(d)) }];
    }
    return widgetDatasetIds(widget).every((d) => kept.has(d)) ? [widget] : [];
  });
}

/** The light list-card shape shared by the caller's apps and the examples gallery. */
function toSummary(app: Doc<"apps">) {
  const pages = appPages(app);
  return {
    _creationTime: app._creationTime,
    _id: app._id,
    datasetCount: app.datasetIds.length,
    description: app.description,
    example: app.example === true,
    pageCount: pages.length,
    sharing: app.sharing,
    title: app.title,
    updatedAt: app.updatedAt,
    widgetCount: pages.reduce((sum, page) => sum + page.widgets.length, 0),
  };
}

/** The caller's own apps, newest first — the /apps browser. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const actorId = await auth(ctx),
      apps = await ctx.db
        .query("apps")
        .withIndex("by_createdBy", (q) => q.eq("createdBy", actorId))
        .order("desc")
        .take(MAX_APPS);
    return apps.map(toSummary);
  },
});

/** The seeded example apps (examples.ts), oldest first — the /apps gallery. */
export const listExamples = query({
  args: {},
  handler: async (ctx) => {
    await auth(ctx);
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_example", (q) => q.eq("example", true))
      .take(MAX_APPS);
    return apps.map(toSummary);
  },
});

/**
 * One app for the viewer or the builder, or `null` when it doesn't exist
 * or the caller may not open it. Takes a plain string: the id arrives from a
 * share URL.
 */
export const get = query({
  args: { appId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      id = normalizeAppId(ctx, args.appId),
      app = id === null ? null : await ctx.db.get("apps", id);
    if (app === null) {
      return null;
    }
    if (!canRead(app, actorId)) {
      return null;
    }
    const owner = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", app.createdBy))
      .unique();
    return {
      _creationTime: app._creationTime,
      _id: app._id,
      canEdit: app.createdBy === actorId && app.example !== true,
      datasetIds: app.datasetIds,
      description: app.description,
      example: app.example === true,
      ownerName: owner === null ? undefined : (owner.name ?? owner.email),
      pages: appPages(app),
      revision: app.revision,
      sharing: app.sharing,
      title: app.title,
      updatedAt: app.updatedAt,
    };
  },
});

export const create = mutation({
  args: { title: v.string(), description: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx);
    return ctx.db.insert("apps", {
      createdBy: actorId,
      datasetIds: [],
      description: cleanDescription(args.description),
      revision: 0,
      sharing: "private",
      pages: [firstPage()],
      title: assertTitle(args.title),
      updatedAt: Date.now(),
    });
  },
});

/** Title, description, and sharing — the app's metadata, saved independently of the layout. */
export const updateDetails = mutation({
  args: {
    appId: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    sharing: v.optional(sharingValidator),
  },
  handler: async (ctx, args) => {
    const app = await appForWrite(ctx, args.appId);
    await ctx.db.patch("apps", app._id, {
      ...(args.title === undefined ? {} : { title: assertTitle(args.title) }),
      ...(args.description === undefined
        ? {}
        : { description: cleanDescription(args.description) }),
      ...(args.sharing === undefined ? {} : { sharing: args.sharing }),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The builder's autosave: replaces the app's data sources and pages in one
 * write (and retires a legacy `widgets` field, now carried by the pages). `expectedRevision` is the revision the editor loaded; a mismatch
 * means another tab saved first, and the save is refused rather than
 * silently overwriting it. Newly added datasets must be visible to the
 * creator (an invisible id must never be written into shareable state —
 * the stage-8 rule); datasets already in the app are kept even if they have
 * since gone away, so a deleted dataset never wedges the editor.
 */
export const saveContent = mutation({
  args: {
    appId: v.string(),
    expectedRevision: v.number(),
    content: appContentValidator,
  },
  handler: async (ctx, args) => {
    const app = await appForWrite(ctx, args.appId);
    if (app.revision !== args.expectedRevision) {
      throw new ConvexError(
        "This app was changed in another tab or window — reload to get the latest version.",
      );
    }
    const { datasetIds, pages } = args.content;
    assertContentShape(datasetIds, pages);
    const existing = new Set(app.datasetIds),
      added = datasetIds.filter((datasetId) => !existing.has(datasetId)),
      visible = await Promise.all(
        added.map(async (datasetId) => datasetVisibleTo(ctx, datasetId, app.createdBy)),
      );
    if (visible.includes(false)) {
      throw new ConvexError("Dataset not found.");
    }
    const revision = app.revision + 1;
    await ctx.db.patch("apps", app._id, {
      datasetIds,
      pages,
      revision,
      updatedAt: Date.now(),
      widgets: undefined,
    });
    return revision;
  },
});

/** "Make a copy": any app the caller can open (examples included) becomes a new private app they own. */
export const duplicate = mutation({
  args: { appId: v.string() },
  handler: async (ctx, args) => {
    const actorId = await auth(ctx),
      id = normalizeAppId(ctx, args.appId),
      app = id === null ? null : await ctx.db.get("apps", id);
    if (app === null || !canRead(app, actorId)) {
      throw new ConvexError("App not found.");
    }
    // A copy may only keep the datasets its new owner can see.
    const visible = await Promise.all(
        app.datasetIds.map(async (datasetId) => datasetVisibleTo(ctx, datasetId, actorId)),
      ),
      datasetIds = app.datasetIds.filter((_, index) => visible[index]),
      kept = new Set(datasetIds),
      pages = appPages(app).map((page) => ({
        ...page,
        widgets: keepReferenced(page.widgets, kept),
      }));
    return ctx.db.insert("apps", {
      createdBy: actorId,
      datasetIds,
      description: app.description,
      revision: 0,
      sharing: "private",
      pages,
      title: `${app.title} (copy)`.slice(0, APP_LIMITS.title),
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { appId: v.string() },
  handler: async (ctx, args) => {
    const app = await appForWrite(ctx, args.appId);
    await ctx.db.delete("apps", app._id);
    return null;
  },
});
