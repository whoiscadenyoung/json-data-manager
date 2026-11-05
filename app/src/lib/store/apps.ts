import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";

/**
 * The apps store — the app builder's PG backend (issue #216): `list` /
 * `listExamples` / `get` / `create` / `updateDetails` / `saveContent` /
 * `duplicate` / `remove` over `public.apps` (migration 0014, the §3.6 sketch
 * block). The Convex reference surface is `api.appBuilder.apps.*`
 * (app/convex/appBuilder/apps.ts, untouched in-tree).
 *
 * Behavior parity notes (each traces to the Convex module):
 *   - Access model: reads are authenticated-open (the maps-domain posture —
 *     RLS is flat `using (true)` for signed-in users, ADR 0009's trusted
 *     collaborator; the Convex `sharing = "private"` hiding does not carry
 *     over, migration 0014's header records the delta). Writes answer only
 *     to the creator, and the seeded examples (0014's system identity) are
 *     writable by NO ONE — a denial arrives as 0 affected rows, which the
 *     helpers below surface honestly instead of reporting success.
 *   - `saveContent` is the builder's autosave: it replaces dataset refs and
 *     pages in ONE write and compares `revision` (the tables.ts doc line:
 *     the optimistic-concurrency counter). A save built on a stale revision
 *     or a non-creator's write affects 0 rows — the stale-save error the
 *     editor shows (`use-app-editor.ts`'s "changed in another tab").
 *   - `duplicate` is "Make a copy" (examples included): any app the caller
 *     can read becomes a new private app they own. Dataset refs are filtered
 *     to what the NEW owner can see (a read on `public.datasets` — invisible
 *     ids drop out under RLS) and widgets whose refs left are dropped
 *     (keepReferenced parity: maps lose the layer, others go).
 *   - Dataset REFERENCES only: ids ride `dataset_ids` with no FK — a deleted
 *     dataset never wedges the editor (the viewer answers "unavailable" per
 *     widget, data.tsx parity).
 *
 * Every write helper returns the rows it affected (the stage-4
 * silent-denial rule): RLS-filtered writes answer 0 rows instead of
 * throwing — a denial reads as not-found, exactly like the Convex creator
 * check answered.
 *
 * NOTE: narrow local interfaces typed from migration 0014's DDL, not the
 * generated `database.types.ts` (see `./client`).
 */

/**
 * Hard bounds — keep an app row small (validators.ts APP_LIMITS parity, the
 * full set the save path enforces; issue #221 restored the slices the first
 * PG cut dropped).
 */
export const APP_LIMITS = {
  datasets: 20,
  description: 2000,
  /** Grid columns — a widget's `w` spans 1..columns. */
  columns: 12,
  /** Tallest widget, in grid row units. */
  maxHeight: 12,
  mapDatasets: 8,
  tableColumns: 50,
  text: 10_000,
  title: 120,
  /** Pages (tabs) per app. */
  pages: 12,
  pageTitle: 60,
  /** Widgets on one page. */
  widgets: 40,
  /** Widgets across every page. */
  totalWidgets: 80,
} as const;

/** How a page uses the screen (validators.ts pageLayoutValidator). */
export type PageLayout = "contained" | "fullscreen";

/**
 * One widget's laid-out footprint. The store carries the order+span grid
 * shape (id/kind/w/h/title) and treats the widget's own payload (datasetId,
 * aggregate, body, …) as opaque jsonb — the widget registry is the feature's
 * shape, never widened here (the layer_styles.style posture).
 */
export interface AppWidgetConfig {
  id: string;
  kind: string;
  /** Column span on the 12-column grid. */
  w: number;
  /** Height in grid row units. */
  h: number;
  title?: string;
  [field: string]: unknown;
}

/** One tab of an app: its own title, layout mode, and laid-out widgets. */
export interface AppPageConfig {
  id: string;
  title: string;
  layout: PageLayout;
  widgets: AppWidgetConfig[];
}

/** The builder's saved content: the app's data sources (shared by every page) and its pages. */
export interface AppContent {
  datasetIds: string[];
  pages: AppPageConfig[];
}

/** One app row, as every reader of `apps` gets it (migration 0014's DDL). */
export interface AppRow {
  id: string;
  title: string;
  description: string | null;
  sharing: "private" | "link";
  datasetIds: string[];
  pages: AppPageConfig[];
  example: boolean;
  /** Optimistic-concurrency counter; saveContent compares and bumps it. */
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The creator's display name — only present on `get`'s profiles embed. */
  ownerName: string | null;
}

/** The light list-card shape (`toSummary` parity; counts derived from the row). */
export interface AppSummary {
  id: string;
  title: string;
  description: string | null;
  sharing: "private" | "link";
  example: boolean;
  datasetCount: number;
  pageCount: number;
  widgetCount: number;
  updatedAt: string;
}

const APP_SELECT =
    "id,title,description,sharing,datasetIds:dataset_ids,pages,example,revision,createdBy:created_by,createdAt:created_at,updatedAt:updated_at",
  APP_SELECT_WITH_OWNER = `${APP_SELECT},ownerName:profiles(name)`;

/** The creator's app-list width (the Convex `list` bound, MAX_APPS). */
export const MAX_APPS = 200;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The light list-card shape shared by the caller's apps and the examples gallery (`toSummary` parity). */
export function toSummary(app: AppRow): AppSummary {
  return {
    datasetCount: app.datasetIds.length,
    description: app.description,
    example: app.example,
    id: app.id,
    pageCount: app.pages.length,
    sharing: app.sharing,
    title: app.title,
    updatedAt: app.updatedAt,
    widgetCount: app.pages.reduce((sum, page) => sum + page.widgets.length, 0),
  };
}

/**
 * The creator's own apps, newest first — the /apps browser (the Convex
 * `list`'s by_createdBy index scope, server-side; MAX_APPS is the width cap).
 * RLS leaves these reads authenticated-open, so the creator filter is
 * explicit here — the browser asks for the signed-in user's id (issue #220:
 * the newest-200 sweep across ALL users rode the flat policy).
 */
export async function list(args: { createdBy: string }, options?: StoreOptions): Promise<AppRow[]> {
  return await queryRows<AppRow>(
    clientOf(options)
      .from("apps")
      .select(APP_SELECT)
      .eq("created_by", args.createdBy)
      .order("created_at", { ascending: false })
      .limit(MAX_APPS),
  );
}

/** The seeded example apps, oldest first — the /apps gallery (the Convex listExamples order). */
export async function listExamples(options?: StoreOptions): Promise<AppRow[]> {
  return await queryRows<AppRow>(
    clientOf(options)
      .from("apps")
      .select(APP_SELECT)
      .eq("example", true)
      .order("created_at", { ascending: true })
      .limit(MAX_APPS),
  );
}

/**
 * One app for the viewer or the builder, or null when it doesn't exist (RLS
 * is authenticated-open, so this is "no such row" — the invisible-row-reads-
 * as-not-found rule still answers null on a foreign/deleted id). The id
 * arrives from a share URL; the profiles embed carries the creator's name.
 */
export async function get(args: { appId: string }, options?: StoreOptions): Promise<AppRow | null> {
  return await queryRow<AppRow>(
    clientOf(options).from("apps").select(APP_SELECT_WITH_OWNER).eq("id", args.appId).limit(1),
  );
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads; design §8.1 — every read a queryOptions)
// ---------------------------------------------------------------------------

export function listQueryOptions(args: { createdBy: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:apps", "list", args],
    queryFn: async () => await list(args, options),
  });
}

export function listExamplesQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:apps", "listExamples"],
    queryFn: async () => await listExamples(options),
  });
}

export function getQueryOptions(args: { appId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:apps", "get", args],
    queryFn: async () => await get(args, options),
  });
}

// ---------------------------------------------------------------------------
// Writes — rows-affected returns (the stage-4 silent-denial rule)
// ---------------------------------------------------------------------------

/** The page a brand-new app starts with (apps.ts firstPage parity). */
export function firstPage(): AppPageConfig {
  return { id: "page-1", layout: "contained", title: "Page 1", widgets: [] };
}

/** The component's title rule ("Give the app a title." / the 120-char bound). */
function assertTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new Error("Give the app a title.");
  }
  if (trimmed.length > APP_LIMITS.title) {
    throw new Error(`Keep the title under ${APP_LIMITS.title} characters.`);
  }
  return trimmed;
}

/** The component's description rule; an emptied field clears the column. */
function cleanDescription(description: string | undefined): string | null {
  const trimmed = (description ?? "").trim();
  if (trimmed.length > APP_LIMITS.description) {
    throw new Error(`Keep the description under ${APP_LIMITS.description} characters.`);
  }
  return trimmed === "" ? null : trimmed;
}

/**
 * Shape rules the DB can't express — the full assertContentShape parity
 * (issue #221): bounds, unique ids, and dataset references closed over the
 * app's sources, checked in the Convex module's order so a multi-violation
 * blob draws the same refusal it always drew.
 */
function assertContent(content: AppContent): void {
  if (content.datasetIds.length > APP_LIMITS.datasets) {
    throw new Error(`An app holds at most ${APP_LIMITS.datasets} datasets.`);
  }
  assertUnique(content.datasetIds, "A dataset is listed twice.");
  if (content.pages.length === 0 || content.pages.length > APP_LIMITS.pages) {
    throw new Error(`An app has 1 to ${APP_LIMITS.pages} pages.`);
  }
  assertUnique(
    content.pages.map((page) => page.id),
    "Two pages share an id.",
  );
  const widgets = content.pages.flatMap((page) => page.widgets);
  if (widgets.length > APP_LIMITS.totalWidgets) {
    throw new Error(`An app holds at most ${APP_LIMITS.totalWidgets} widgets in all.`);
  }
  assertUnique(
    widgets.map((widget) => widget.id),
    "Two widgets share an id.",
  );
  for (const page of content.pages) {
    assertPageShape(page);
  }
  const sources = new Set(content.datasetIds);
  for (const widget of widgets) {
    assertWidgetShape(widget, sources);
  }
}

/** Per-page bounds (assertPage parity): a trimmed non-empty title and the per-page widget cap. */
function assertPageShape(page: AppPageConfig): void {
  // The trim target rides an unknown binding: the wire is jsonb and the
  // interface's `string` can't vouch for it (assertInteger's posture).
  const titleValue: unknown = page.title,
    title = typeof titleValue === "string" ? titleValue.trim() : "";
  if (title === "" || title.length > APP_LIMITS.pageTitle) {
    throw new Error(`Give every page a title of up to ${APP_LIMITS.pageTitle} characters.`);
  }
  if (page.widgets.length > APP_LIMITS.widgets) {
    throw new Error(`A page holds at most ${APP_LIMITS.widgets} widgets.`);
  }
}

/** The Convex assertUnique: every id in the list distinct. */
function assertUnique(ids: readonly string[], message: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(message);
  }
}

/** The Convex assertInteger, widened to unknown — malformed jsonb refuses with the same message a bound violation draws. */
function assertInteger(value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
}

/** Every dataset id one widget reads (content.ts widgetDatasetIds parity over the store's opaque payload). */
function widgetDatasetIdsOf(widget: AppWidgetConfig): string[] {
  if (widget.kind === "map") {
    const datasetIds = widget["datasetIds"];
    return Array.isArray(datasetIds)
      ? datasetIds.filter((id): id is string => typeof id === "string")
      : [];
  }
  if (widget.kind === "text") {
    return [];
  }
  const datasetId = widget["datasetId"];
  return typeof datasetId === "string" ? [datasetId] : [];
}

/** Per-widget bounds then the source closure (assertWidget parity, messages verbatim). */
function assertWidgetShape(widget: AppWidgetConfig, sources: ReadonlySet<string>): void {
  assertInteger(widget.w, 1, APP_LIMITS.columns, "A widget's width");
  assertInteger(widget.h, 1, APP_LIMITS.maxHeight, "A widget's height");
  if (
    widget.title !== undefined &&
    (typeof widget.title !== "string" || widget.title.length > APP_LIMITS.title)
  ) {
    throw new Error(`Keep widget titles under ${APP_LIMITS.title} characters.`);
  }
  assertWidgetBoundsOf(widget);
  if (widgetDatasetIdsOf(widget).some((id) => !sources.has(id))) {
    throw new Error("A widget uses a dataset that isn't in this app — add it first.");
  }
}

/** Per-kind bounds (assertWidgetBounds parity), one guard function per kind. */
function assertWidgetBoundsOf(widget: AppWidgetConfig): void {
  assertTextWidgetOf(widget);
  assertMapWidgetOf(widget);
  assertTableWidgetOf(widget);
  assertChartWidgetOf(widget);
}

function assertTextWidgetOf(widget: AppWidgetConfig): void {
  if (widget.kind !== "text") {
    return;
  }
  const body = widget["body"];
  if (typeof body !== "string" || body.length > APP_LIMITS.text) {
    throw new Error(`Keep text blocks under ${APP_LIMITS.text} characters.`);
  }
}

function assertMapWidgetOf(widget: AppWidgetConfig): void {
  if (widget.kind !== "map") {
    return;
  }
  const datasetIds = widget["datasetIds"];
  if (!Array.isArray(datasetIds) || datasetIds.length > APP_LIMITS.mapDatasets) {
    throw new Error(`A map shows at most ${APP_LIMITS.mapDatasets} datasets.`);
  }
}

function assertTableWidgetOf(widget: AppWidgetConfig): void {
  if (widget.kind !== "table") {
    return;
  }
  const columns = widget["columns"];
  if (!Array.isArray(columns) || columns.length > APP_LIMITS.tableColumns) {
    throw new Error(`A table shows at most ${APP_LIMITS.tableColumns} columns.`);
  }
}

function assertChartWidgetOf(widget: AppWidgetConfig): void {
  if (widget.kind !== "chart") {
    return;
  }
  assertInteger(widget["limit"], 1, 50, "A chart's group limit");
}

/**
 * Creates a private app with its first page. Returns the full row — the
 * shipped `.insert().select()` shape (RETURNING passes the flat SELECT
 * policy on the new row; the pg-apps int test pins the 0008 lesson).
 */
export async function create(
  args: { title: string; description?: string },
  options?: StoreOptions,
): Promise<AppRow> {
  // Validation runs BEFORE the builder chain: an invalid payload must not
  // open a query (the request only goes out once the args are clean).
  const title = assertTitle(args.title),
    description = cleanDescription(args.description);
  const row = await queryRow<AppRow>(
    clientOf(options)
      .from("apps")
      .insert({ description, pages: [firstPage()], title })
      .select(APP_SELECT)
      .single(),
  );
  if (row === null) {
    throw new Error("App insert returned no row.");
  }
  return row;
}

/**
 * Title, description, and sharing — the app's metadata, saved independently
 * of the layout (updateDetails parity). Returns the affected row count (0 =
 * denied or gone).
 */
export async function updateDetails(
  args: { appId: string; title?: string; description?: string; sharing?: AppRow["sharing"] },
  options?: StoreOptions,
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) {
    patch.title = assertTitle(args.title);
  }
  if (args.description !== undefined) {
    patch.description = cleanDescription(args.description);
  }
  if (args.sharing !== undefined) {
    patch.sharing = args.sharing;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("App update needs a field to set.");
  }
  const rows = await queryRows<{ id: string }>(
    clientOf(options)
      .from("apps")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", args.appId)
      .select("id"),
  );
  return rows.length;
}

/**
 * The builder's autosave: replaces the app's data sources and pages in one
 * write, gated on the revision the editor loaded. Returns the new revision.
 * Throws the stale-save error when 0 rows matched — a stale revision
 * (another tab saved first) or a non-creator's write, which are
 * indistinguishable by design (the Convex appForWrite shape answered "App
 * not found." for both).
 *
 * Sources gate on visibility (issue #221, saveContent parity): only the
 * ADDED ids answer to RLS — the datasets already in the app are kept even
 * if they have since gone away, so a deleted dataset never wedges the
 * editor (the Convex module's added-only walk; one `.in` read instead of
 * one per id, the duplicate() precedent). An invisible or deleted addition
 * refuses as "Dataset not found." — the Convex error verbatim.
 */
export async function saveContent(
  args: { appId: string; expectedRevision: number; content: AppContent },
  options?: StoreOptions,
): Promise<number> {
  assertContent(args.content);
  const client = clientOf(options);
  const current = await queryRow<{ datasetIds: string[] }>(
    client.from("apps").select("datasetIds:dataset_ids").eq("id", args.appId).limit(1),
  );
  const existing = new Set(current === null ? [] : current.datasetIds),
    added = args.content.datasetIds.filter((datasetId) => !existing.has(datasetId));
  if (added.length > 0) {
    const visible = await queryRows<{ id: string }>(
      client.from("datasets").select("id").in("id", added),
    );
    if (visible.length !== added.length) {
      throw new Error("Dataset not found.");
    }
  }
  const rows = await queryRows<{ revision: number }>(
    client
      .from("apps")
      .update({
        dataset_ids: args.content.datasetIds,
        pages: args.content.pages,
        revision: args.expectedRevision + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", args.appId)
      .eq("revision", args.expectedRevision)
      .select("revision"),
  );
  if (rows.length === 0) {
    throw new Error(
      "This app was changed in another tab or window — reload to get the latest version.",
    );
  }
  const saved = rows[0];
  return saved === undefined ? args.expectedRevision + 1 : saved.revision;
}

/** "Make a copy": any app the caller can read (examples included) becomes a new private app they own. Returns the full row. */
export async function duplicate(
  args: { appId: string },
  options?: StoreOptions,
): Promise<AppRow | null> {
  const client = clientOf(options);
  const source = await get({ appId: args.appId }, options);
  if (source === null) {
    return null;
  }
  // A copy may only keep the datasets its new owner can see: the read drops
  // invisible ids under RLS (duplicate's datasetVisibleTo walk, one query
  // instead of one per id). Empty sources skip the read — `.in([])` is a
  // malformed PostgREST request, not an empty answer.
  const kept = new Set<string>();
  if (source.datasetIds.length > 0) {
    const visible = await queryRows<{ id: string }>(
      client.from("datasets").select("id").in("id", source.datasetIds),
    );
    for (const row of visible) {
      kept.add(row.id);
    }
  }
  const pages = source.pages.map((page) => ({
    ...page,
    widgets: keepReferenced(page.widgets, kept),
  }));
  const row = await queryRow<AppRow>(
    client
      .from("apps")
      .insert({
        dataset_ids: [...kept],
        description: source.description ?? undefined,
        pages,
        title: `${source.title} (copy)`.slice(0, APP_LIMITS.title),
      })
      .select(APP_SELECT)
      .single(),
  );
  return row;
}

/** Deletes the app. Returns the affected row count (0 = denied or gone). */
export async function remove(args: { appId: string }, options?: StoreOptions): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    clientOf(options).from("apps").delete().eq("id", args.appId).select("id"),
  );
  return rows.length;
}

/** A widget list with every reference outside `kept` dropped (maps lose the layer; others go) — apps.ts keepReferenced parity. */
function keepReferenced(widgets: AppWidgetConfig[], kept: ReadonlySet<string>): AppWidgetConfig[] {
  return widgets.flatMap((widget): AppWidgetConfig[] => {
    if (widget.kind === "map") {
      const datasetIds = widget["datasetIds"];
      return [
        {
          ...widget,
          datasetIds: Array.isArray(datasetIds)
            ? datasetIds.filter((id): id is string => typeof id === "string" && kept.has(id))
            : [],
        },
      ];
    }
    const datasetId = widget["datasetId"];
    return typeof datasetId === "string" && kept.has(datasetId) ? [widget] : [];
  });
}
