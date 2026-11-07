import type { VisibilityLevel } from "#/lib/store/visibility";

/**
 * The app builder's stored shapes — the Postgres port of the Convex-era
 * `convex/appBuilder/validators.ts` (READ-ONLY reference). The feature owns
 * its content types now, declared once and shared by the editor, the viewer,
 * and the widgets, so adding a widget kind is: one interface below, one
 * entry in the client widget registry.
 *
 * Pages and their widgets ride the `apps.pages` jsonb column (design doc
 * §3.6 — "inline bounded layout, component parity"). Postgres stores them
 * unvalidated, so the shapes below are the one contract every writer (this
 * feature's `saveContent` payload) and every reader (`appPagesOf`) agrees
 * on; the store hands the column back untouched.
 *
 * Datasets are referenced by PG dataset ids (uuid, `apps.dataset_ids`) — the
 * Convex-era dataset-ref behavior carries over: an app stores REFERENCES,
 * never data or grants. Every widget read goes through the viewer's own
 * dataset access, so sharing an app never widens who can see a dataset.
 */

/** Hard bounds — keep an app row small (it is rewritten per save). */
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
  /** Widgets across every page — keeps the one app row small. */
  totalWidgets: 80,
} as const;

/**
 * Who may open an app, on the unified visibility ladder (#260, ADR 0022):
 * `members` (the project seat), `signed-in` (the trusted-collaborator
 * posture, ADR 0009), `link`/`public` (the anon rungs — serving lands in
 * [project 7]). The old two-literal `Sharing` union retired with
 * `apps.sharing` in migration 0023.
 */
export type Visibility = VisibilityLevel;

export type Aggregate = "count" | "sum" | "avg" | "min" | "max";

/** How a page uses the screen: a centered document (`contained`) or edge-to-edge (`fullscreen`). */
export type PageLayout = "contained" | "fullscreen";

/** Layout + chrome every widget carries: a stable client-minted id, an optional title, and its grid footprint. */
interface WidgetBase {
  id: string;
  title?: string;
  /** Column span on the 12-column grid. */
  w: number;
  /** Height in grid row units. */
  h: number;
}

export interface TextWidget extends WidgetBase {
  kind: "text";
  /** Plain text with a tiny markdown subset (`#` headings, `-` bullets, paragraphs). */
  body: string;
}

export interface StatWidget extends WidgetBase {
  kind: "stat";
  datasetId: string;
  aggregate: Aggregate;
  /** The numeric field `sum`/`avg`/`min`/`max` read; unused for `count`. */
  field?: string;
}

export interface ChartWidget extends WidgetBase {
  kind: "chart";
  datasetId: string;
  chartType: "bar" | "line" | "area" | "donut";
  /** The category / x field rows are grouped by. */
  groupBy?: string;
  aggregate: Aggregate;
  /** The numeric field the aggregate reads; unused for `count`. */
  valueField?: string;
  sort: "value-desc" | "label-asc";
  /** Most groups drawn; the rest fold into "Other". */
  limit: number;
}

export interface TableWidget extends WidgetBase {
  kind: "table";
  datasetId: string;
  /** Visible columns in order; empty = every field of the dataset. */
  columns: string[];
}

export interface MapWidget extends WidgetBase {
  kind: "map";
  /**
   * The stored project map this widget shows (issue #259, D7 — a map built
   * anywhere in the app is a map row; the inline `datasetIds` map mode
   * retired). Empty string = not chosen yet (the settings prompt).
   */
  mapId: string;
}

export type Widget = TextWidget | StatWidget | ChartWidget | TableWidget | MapWidget;

export type WidgetKind = Widget["kind"];

/** One tab of an app: its own title, layout mode, and laid-out widgets. */
export interface AppPage {
  id: string;
  title: string;
  layout: PageLayout;
  widgets: Widget[];
}

/** The builder's saved content: the app's data sources (shared by every page) and its pages. */
export interface AppContent {
  datasetIds: string[];
  pages: AppPage[];
}

/** Every dataset id one widget reads (the save gate's reference check and the client share it) — maps read stored maps now, not the app's datasets. */
export function widgetDatasetIds(widget: Widget): string[] {
  switch (widget.kind) {
    case "map": {
      return [];
    }
    case "text": {
      return [];
    }
    default: {
      return [widget.datasetId];
    }
  }
}

/** The id of the page a null/empty `pages` column is read as. */
export const LEGACY_PAGE_ID = "page-1";

/** The page a brand-new app starts with (the store's `create` writes it too). */
export function firstPage(): AppPage {
  return { id: LEGACY_PAGE_ID, layout: "contained", title: "Page 1", widgets: [] };
}

/**
 * The `apps.pages` jsonb column as the app's pages. An app always HAS a page
 * (the save gate refuses zero), so a null column — a hand-written row, or a
 * create-path row saved before pages existed — reads as one empty first
 * page, exactly as the Convex-era `appPages` shim read legacy documents.
 */
export function appPagesOf(pages: AppPage[] | null | undefined): AppPage[] {
  if (pages !== null && pages !== undefined && pages.length > 0) {
    return pages;
  }
  return [firstPage()];
}
