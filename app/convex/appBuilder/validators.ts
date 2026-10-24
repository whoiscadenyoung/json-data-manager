import { v, type Infer } from "convex/values";

/**
 * The app builder's stored shapes (docs/app-builder.md). Everything the
 * builder persists is declared here once — the `apps` table, the mutations'
 * args, and the client's types (`Infer<…>` in
 * `app/src/features/app-builder/types.ts`) all derive from these validators,
 * so adding a widget kind is: one validator below, one entry in the client
 * widget registry.
 *
 * Datasets are referenced by plain-string component ids (the host-boundary
 * id rule — component tables are absent from the host data model).
 */

/** Hard bounds — keep an app document small (it is one row, rewritten per save). */
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
  widgets: 40,
} as const;

/** Who may open an app's share URL besides its creator. */
export const sharingValidator = v.union(
  // Only the creator.
  v.literal("private"),
  // Any signed-in user holding the link (the trusted-collaborator model,
  // ADR 0009 — the app-wide sign-in gate still applies).
  v.literal("link"),
);

export const aggregateValidator = v.union(
  v.literal("count"),
  v.literal("sum"),
  v.literal("avg"),
  v.literal("min"),
  v.literal("max"),
);

/** Layout + chrome every widget carries: a stable client-minted id, an optional title, and its grid footprint. */
const widgetBase = v.object({
  id: v.string(),
  title: v.optional(v.string()),
  /** Column span on the 12-column grid. */
  w: v.number(),
  /** Height in grid row units. */
  h: v.number(),
});

export const textWidgetValidator = widgetBase.extend({
  kind: v.literal("text"),
  /** Plain text with a tiny markdown subset (`#` headings, `-` bullets, paragraphs). */
  body: v.string(),
});

export const statWidgetValidator = widgetBase.extend({
  kind: v.literal("stat"),
  datasetId: v.string(),
  aggregate: aggregateValidator,
  /** The numeric field `sum`/`avg`/`min`/`max` read; unused for `count`. */
  field: v.optional(v.string()),
});

export const chartWidgetValidator = widgetBase.extend({
  kind: v.literal("chart"),
  datasetId: v.string(),
  chartType: v.union(v.literal("bar"), v.literal("line"), v.literal("area"), v.literal("donut")),
  /** The category / x field rows are grouped by. */
  groupBy: v.optional(v.string()),
  aggregate: aggregateValidator,
  /** The numeric field the aggregate reads; unused for `count`. */
  valueField: v.optional(v.string()),
  sort: v.union(v.literal("value-desc"), v.literal("label-asc")),
  /** Most groups drawn; the rest fold into "Other". */
  limit: v.number(),
});

export const tableWidgetValidator = widgetBase.extend({
  kind: v.literal("table"),
  datasetId: v.string(),
  /** Visible columns in order; empty = every field of the dataset. */
  columns: v.array(v.string()),
});

export const mapWidgetValidator = widgetBase.extend({
  kind: v.literal("map"),
  /** The datasets drawn as layers, bottom to top. */
  datasetIds: v.array(v.string()),
});

export const widgetValidator = v.union(
  textWidgetValidator,
  statWidgetValidator,
  chartWidgetValidator,
  tableWidgetValidator,
  mapWidgetValidator,
);

/** The builder's saved content: the app's data sources and its laid-out widgets. */
export const appContentValidator = v.object({
  datasetIds: v.array(v.string()),
  widgets: v.array(widgetValidator),
});

export type Widget = Infer<typeof widgetValidator>;
export type WidgetKind = Widget["kind"];
export type AppContent = Infer<typeof appContentValidator>;
export type Aggregate = Infer<typeof aggregateValidator>;
export type Sharing = Infer<typeof sharingValidator>;

/** Every dataset id one widget reads — shared by the server's reference check and the client. */
export function widgetDatasetIds(widget: Widget): string[] {
  switch (widget.kind) {
    case "map": {
      return widget.datasetIds;
    }
    case "text": {
      return [];
    }
    default: {
      return [widget.datasetId];
    }
  }
}
