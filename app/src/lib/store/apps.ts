import { queryOptions } from "@tanstack/react-query";

import { clientOf, queryRow, queryRows, type StoreOptions } from "./client";
import type { VisibilityLevel } from "./visibility";

/**
 * The apps store — the app builder's PG backend, re-owned by projects
 * (issue #259, the project-centric train's phase 5; ADR 0021 over migration
 * 0022). `listVisible` / `get` / `create` / `updateDetails` / `saveContent` /
 * `duplicate` / `remove` over `public.apps`; publish/freezing lives in
 * `#/features/publishing/lib/pg-app-publish` + `./app-versions`.
 *
 * The recorded shapes (ADR 0021):
 *   - Apps are PROJECT-OWNED rows (`project_id` NOT NULL): reads are
 *     member-wide with the seeded examples' one `example` arm; writes are
 *     project-editor+ (the 0018 role split, the 0020 maps posture — the
 *     0014 creator gate died). The system examples stay writable by NO ONE.
 *   - Map widgets reference STORED project maps (`mapId`) — the inline
 *     `datasetIds` map mode retired; `widgetDatasetIdsOf` answers [] for
 *     maps. `create` mints the kind-'app' OWNED membership in
 *     `project_artifacts` (the layers-store pattern — clients cannot
 *     addArtifact an app).
 *   - `saveContent` is the builder's autosave: it replaces dataset refs and
 *     pages in ONE write and compares `revision` (the optimistic-concurrency
 *     counter, unchanged from 0014). A save built on a stale revision or a
 *     non-editor's write affects 0 rows — the stale-save error the editor
 *     shows (`use-app-editor.ts`'s "changed in another tab").
 *   - `duplicate` is "Make a copy" (examples included): any app the caller
 *     can read becomes a new app in the CALLER'S chosen project (apps are
 *     project-owned now, so the copy target is explicit). Dataset refs are
 *     filtered to what the new owner can see; a map reference survives only
 *     if the map itself is visible to them (the same rule, applied to the
 *     stored-map reference) — widgets whose refs left are dropped
 *     (keepReferenced parity: maps whose map went away are dropped whole).
 *   - Dataset REFERENCES only: ids ride `dataset_ids` with no FK — a deleted
 *     dataset never wedges the editor (the viewer answers "unavailable" per
 *     widget, data.tsx parity).
 *
 * Every write helper returns the rows it affected (the stage-4
 * silent-denial rule): RLS-filtered writes answer 0 rows instead of
 * throwing — a denial reads as not-found, exactly like the Convex creator
 * check answered.
 *
 * NOTE: narrow local interfaces typed from migration 0022's DDL, not the
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
 * aggregate, mapId, body, …) as opaque jsonb — the widget registry is the
 * feature's shape, never widened here (the layer_styles.style posture).
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

/** The owning project's light shape (the explorer's chip + the pages' role resolution). */
export interface AppProjectRef {
  id: string;
  title: string;
  createdBy: string;
}

/** One app row, as every reader of `apps` gets it (migration 0022's DDL). */
export interface AppRow {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  visibility: VisibilityLevel;
  datasetIds: string[];
  pages: AppPageConfig[];
  example: boolean;
  /** Optimistic-concurrency counter; saveContent compares and bumps it. */
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The owning project's embed — null when the viewer cannot read the
   * project row (a signed-in non-member reading an example app; the ladder
   * in [project 6] owns widening project reads).
   */
  project: AppProjectRef | null;
}

/** The light list-card shape (`toSummary` parity; counts derived from the row). */
export interface AppSummary {
  id: string;
  project: AppProjectRef | null;
  title: string;
  description: string | null;
  visibility: VisibilityLevel;
  example: boolean;
  datasetCount: number;
  pageCount: number;
  widgetCount: number;
  updatedAt: string;
}

const APP_SELECT =
    "id,projectId:project_id,title,description,visibility,datasetIds:dataset_ids,pages,example,revision,createdBy:created_by,createdAt:created_at,updatedAt:updated_at",
  APP_SELECT_WITH_PROJECT = `${APP_SELECT},project:projects(id,title,created_by)`;

/** The explorer's list width (the /apps explorer's cap; MAX_APPS carried). */
export const MAX_APPS = 200;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The light list-card shape shared by every listing surface (`toSummary` parity). */
export function toSummary(app: AppRow): AppSummary {
  return {
    datasetCount: app.datasetIds.length,
    description: app.description,
    example: app.example,
    id: app.id,
    pageCount: app.pages.length,
    project: app.project,
    visibility: app.visibility,
    title: app.title,
    updatedAt: app.updatedAt,
    widgetCount: app.pages.reduce((sum, page) => sum + page.widgets.length, 0),
  };
}

/**
 * The stored-map ids a live app's widgets reference — the maps-side
 * back-reference scan (issue #262's "used in"). Widget payloads are opaque
 * jsonb in this store, so this reads the one key the builder's map widget
 * writes (`mapId`); other widget shapes never carry it.
 */
export function appMapIds(app: AppRow): string[] {
  const ids: string[] = [];
  for (const page of app.pages) {
    for (const widget of page.widgets) {
      const mapId = widget["mapId"];
      if (typeof mapId === "string" && !ids.includes(mapId)) {
        ids.push(mapId);
      }
    }
  }
  return ids;
}

/** Whether the app's shared data sources include a dataset (`datasetIds` is the builder's table/chart source list). */
export function appUsesDataset(app: AppRow, datasetId: string): boolean {
  return app.datasetIds.includes(datasetId);
}

/**
 * Every app the viewer can see, newest first — the /apps EXPLORER's list
 * (issue #259: the explorer browses; creation lives in projects). RLS
 * answers member-wide + the example arm; the project embed carries the
 * chips (null on unreadable projects — the example case).
 */
export async function listVisible(options?: StoreOptions): Promise<AppRow[]> {
  return await queryRows<AppRow>(
    clientOf(options)
      .from("apps")
      .select(APP_SELECT_WITH_PROJECT)
      .order("created_at", { ascending: false })
      .limit(MAX_APPS),
  );
}

/**
 * One app for the viewer or the builder, or null when it doesn't exist (RLS
 * member-wide, so this is "no such row" — the invisible-row-reads-as-
 * not-found rule still answers null on a foreign/deleted id). The id
 * arrives from a share URL; the embed carries the project chip.
 */
export async function get(args: { appId: string }, options?: StoreOptions): Promise<AppRow | null> {
  return await queryRow<AppRow>(
    clientOf(options).from("apps").select(APP_SELECT_WITH_PROJECT).eq("id", args.appId).limit(1),
  );
}

/** One project's apps, newest first — the project workspace's Apps section (the Maps-section shape). */
export async function listForProject(
  args: { projectId: string },
  options?: StoreOptions,
): Promise<AppRow[]> {
  return await queryRows<AppRow>(
    clientOf(options)
      .from("apps")
      .select(APP_SELECT_WITH_PROJECT)
      .eq("project_id", args.projectId)
      .order("created_at", { ascending: false })
      .limit(MAX_APPS),
  );
}

// ---------------------------------------------------------------------------
// TanStack Query options (reads; design §8.1 — every read a queryOptions)
// ---------------------------------------------------------------------------

export function listVisibleQueryOptions(options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:apps", "listVisible"],
    queryFn: async () => await listVisible(options),
  });
}

export function getQueryOptions(args: { appId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:apps", "get", args],
    queryFn: async () => await get(args, options),
  });
}

export function listForProjectQueryOptions(args: { projectId: string }, options?: StoreOptions) {
  return queryOptions({
    queryKey: ["pg:apps", "listForProject", args],
    queryFn: async () => await listForProject(args, options),
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
 * blob draws the same refusal it always drew. Map widgets reference a
 * stored project map by id (issue #259) — shape-checked as a string, never
 * against the app's datasets.
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

/** Every dataset id one widget reads (content.ts widgetDatasetIds parity over the store's opaque payload) — maps read stored maps now, not the app's datasets. */
function widgetDatasetIdsOf(widget: AppWidgetConfig): string[] {
  if (widget.kind === "map" || widget.kind === "text") {
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
  const mapId = widget["mapId"];
  if (typeof mapId !== "string") {
    throw new Error("A map widget names the project map it shows.");
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
 * Creates an app IN a project (issue #259: creation lives in project flows)
 * with its first page, and mints the kind-'app' OWNED membership the
 * catalog reads (the layers-store pattern — the client-facing addArtifact
 * never sees kind 'app'). Returns the full row — the shipped
 * `.insert().select()` shape (RETURNING passes the flat SELECT policy on
 * the new row; the pg-apps int test pins the 0008 lesson).
 */
export async function create(
  args: { projectId: string; title: string; description?: string },
  options?: StoreOptions,
): Promise<AppRow> {
  // Validation runs BEFORE the builder chain: an invalid payload must not
  // open a query (the request only goes out once the args are clean).
  const title = assertTitle(args.title),
    description = cleanDescription(args.description);
  const row = await queryRow<AppRow>(
    clientOf(options)
      .from("apps")
      .insert({
        description,
        pages: [firstPage()],
        project_id: args.projectId,
        title,
      })
      .select(APP_SELECT)
      .single(),
  );
  if (row === null) {
    throw new Error("App insert returned no row.");
  }
  const membership = await queryRow<{ id: string }>(
    clientOf(options)
      .from("project_artifacts")
      .insert({
        artifact_id: row.id,
        artifact_kind: "app",
        project_id: args.projectId,
        role: "owned",
        sync_mode: "manual",
      })
      .select("id")
      .single(),
  );
  if (membership === null) {
    throw new Error("The app was created but its project membership didn't mint.");
  }
  return row;
}

/**
 * Title, description, and visibility — the app's metadata, saved
 * independently of the layout (updateDetails parity; the ladder rung rides
 * the plain RLS'd write — widening goes through the closure preflight's
 * apply, #260). Returns the affected row count (0 = denied or gone).
 */
export async function updateDetails(
  args: {
    appId: string;
    title?: string;
    description?: string;
    visibility?: AppRow["visibility"];
  },
  options?: StoreOptions,
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (args.title !== undefined) {
    patch.title = assertTitle(args.title);
  }
  if (args.description !== undefined) {
    patch.description = cleanDescription(args.description);
  }
  if (args.visibility !== undefined) {
    patch.visibility = args.visibility;
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
 * (another tab saved first) or a non-editor's write, which are
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

/**
 * "Make a copy": any app the caller can read (examples included) becomes a
 * new app in the CALLER'S chosen project (apps are project-owned — the
 * target is explicit). Returns the full row, or null when the source is
 * invisible. Dataset refs the new owner cannot see drop out (the RLS read
 * answers only visible ids); a map reference survives only if the map is
 * visible to them too — the map widget drops whole when it isn't
 * (keepReferenced parity, applied to the stored-map reference).
 */
export async function duplicate(
  args: { appId: string; projectId: string },
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
  // Map references: kept only when the map row itself resolves for the
  // caller (RLS member-wide — a non-member's copy of an example drops the
  // widget instead of shipping a map they can never open).
  const mapIds = new Set(
    source.pages
      .flatMap((page) => page.widgets)
      .filter((widget) => widget.kind === "map")
      .map((widget) => widget["mapId"])
      .filter((mapId): mapId is string => typeof mapId === "string" && mapId !== ""),
  );
  const visibleMaps = new Set<string>();
  if (mapIds.size > 0) {
    const rows = await queryRows<{ id: string }>(
      client
        .from("maps")
        .select("id")
        .in("id", [...mapIds]),
    );
    for (const row of rows) {
      visibleMaps.add(row.id);
    }
  }
  const pages = source.pages.map((page) => ({
    ...page,
    widgets: page.widgets.flatMap((widget): AppWidgetConfig[] => {
      if (widget.kind === "map") {
        const mapId = widget["mapId"];
        return typeof mapId === "string" && visibleMaps.has(mapId) ? [widget] : [];
      }
      const datasetId = widget["datasetId"];
      return typeof datasetId === "string" && kept.has(datasetId) ? [widget] : [];
    }),
  }));
  const row = await queryRow<AppRow>(
    client
      .from("apps")
      .insert({
        dataset_ids: [...kept],
        description: source.description ?? undefined,
        pages,
        project_id: args.projectId,
        title: `${source.title} (copy)`.slice(0, APP_LIMITS.title),
      })
      .select(APP_SELECT)
      .single(),
  );
  if (row !== null) {
    await queryRow<{ id: string }>(
      client
        .from("project_artifacts")
        .insert({
          artifact_id: row.id,
          artifact_kind: "app",
          project_id: args.projectId,
          role: "owned",
          sync_mode: "manual",
        })
        .select("id")
        .single(),
    );
  }
  return row;
}

/** Deletes the app; its kind-'app' membership goes with it by the store's cleanup. Returns the affected row count (0 = denied or gone). */
export async function remove(args: { appId: string }, options?: StoreOptions): Promise<number> {
  const client = clientOf(options);
  const app = await queryRow<{ projectId: string }>(
    client.from("apps").select("projectId:project_id").eq("id", args.appId).limit(1),
  );
  if (app === null) {
    return 0;
  }
  await queryRows<unknown>(
    client
      .from("project_artifacts")
      .delete()
      .eq("artifact_kind", "app")
      .eq("artifact_id", args.appId)
      .eq("project_id", app.projectId)
      .select("id"),
  );
  const rows = await queryRows<{ id: string }>(
    client.from("apps").delete().eq("id", args.appId).select("id"),
  );
  return rows.length;
}
