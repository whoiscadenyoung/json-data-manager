import { BarChart3, Hash, MapIcon, Table2, Type, type LucideIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { QueryErrorBoundary } from "#/components/query-error-boundary";
import type { Widget, WidgetKind } from "#convex/appBuilder/validators";

import type { DatasetState } from "../data";
import { numericFields } from "../lib/fields";
import { DEFAULT_SIZES, newWidgetId } from "../lib/layout";
import { WidgetMessage } from "./shared";
import { StatWidgetSettings, StatWidgetView } from "./stat-widget";
import { TableWidgetSettings, TableWidgetView } from "./table-widget";
import { TextWidgetSettings, TextWidgetView } from "./text-widget";

/**
 * The widget registry — the one file that knows every widget kind. Adding a
 * kind: its validator in `convex/appBuilder/validators.ts`, a module in this
 * folder exporting a View and a Settings component, then one entry in
 * `WIDGET_KINDS` and one case in each switch below (TypeScript's
 * exhaustiveness check points at every place that needs it).
 *
 * The heavy kinds (map: MapLibre; chart: Recharts) load lazily so an app
 * without them never downloads them.
 */

const ChartWidgetView = lazy(async () =>
    import("./chart-widget").then((module) => ({ default: module.ChartWidgetView })),
  ),
  ChartWidgetSettings = lazy(async () =>
    import("./chart-widget").then((module) => ({ default: module.ChartWidgetSettings })),
  ),
  MapWidgetView = lazy(async () =>
    import("./map-widget").then((module) => ({ default: module.MapWidgetView })),
  ),
  MapWidgetSettings = lazy(async () =>
    import("./map-widget").then((module) => ({ default: module.MapWidgetSettings })),
  );

export interface WidgetKindInfo {
  kind: WidgetKind;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Whether the kind reads a dataset (the add menu disables it until the app has one). */
  needsData: boolean;
}

export const WIDGET_KINDS: readonly WidgetKindInfo[] = [
  {
    description: "Plot geospatial datasets as layers",
    icon: MapIcon,
    kind: "map",
    label: "Map",
    needsData: true,
  },
  {
    description: "Bar, line, area, or donut from a field",
    icon: BarChart3,
    kind: "chart",
    label: "Chart",
    needsData: true,
  },
  {
    description: "Browse a dataset's rows",
    icon: Table2,
    kind: "table",
    label: "Table",
    needsData: true,
  },
  {
    description: "One headline number",
    icon: Hash,
    kind: "stat",
    label: "Number",
    needsData: true,
  },
  { description: "Headings and notes", icon: Type, kind: "text", label: "Text", needsData: false },
];

export function widgetKindInfo(kind: WidgetKind): WidgetKindInfo {
  return WIDGET_KINDS.find((info) => info.kind === kind) ?? WIDGET_KINDS[0];
}

function firstMatching(
  datasetIds: readonly string[],
  states: ReadonlyMap<string, DatasetState>,
  predicate: (state: DatasetState) => boolean,
): string | undefined {
  return datasetIds.find((id) => {
    const state = states.get(id);
    return state !== undefined && predicate(state);
  });
}

const isGeospatial = (state: DatasetState) =>
  state.status === "ready" && state.doc.kind === "geospatial";

/** A sensible starting group-by: the preferred dataset's first text field, else its first field. */
function firstField(state: DatasetState | undefined): string | undefined {
  if (state === undefined || state.status !== "ready") {
    return undefined;
  }
  const chosen = state.fields.find((field) => field.type === "string") ?? state.fields.at(0);
  return chosen === undefined ? undefined : chosen.name;
}

/** The preferred dataset's first numeric field — a number widget sums it. */
function firstNumericField(state: DatasetState | undefined): string | undefined {
  const numeric =
    state !== undefined && state.status === "ready" ? numericFields(state.fields) : [];
  return numeric.length > 0 ? numeric[0].name : undefined;
}

/**
 * A new widget of `kind` with sensible defaults drawn from the app's data:
 * maps start on the first geospatial dataset, charts group by its first
 * field, numbers count its rows.
 */
export function createWidget(
  kind: WidgetKind,
  datasetIds: readonly string[],
  states: ReadonlyMap<string, DatasetState>,
): Widget {
  const base = { id: newWidgetId(), ...DEFAULT_SIZES[kind] },
    preferred = datasetIds.at(-1) ?? "",
    preferredState = states.get(preferred);
  switch (kind) {
    case "text": {
      return { ...base, body: "## Section title\nDescribe what this part of the app shows.", kind };
    }
    case "map": {
      const geo = firstMatching(datasetIds.toReversed(), states, isGeospatial);
      return { ...base, datasetIds: geo === undefined ? [] : [geo], kind };
    }
    case "chart": {
      return {
        ...base,
        aggregate: "count",
        chartType: "bar",
        datasetId: preferred,
        groupBy: firstField(preferredState),
        kind,
        limit: 10,
        sort: "value-desc",
      };
    }
    case "table": {
      return { ...base, columns: [], datasetId: preferred, kind };
    }
    case "stat": {
      const field = firstNumericField(preferredState);
      return field === undefined
        ? { ...base, aggregate: "count", datasetId: preferred, kind }
        : { ...base, aggregate: "sum", datasetId: preferred, field, kind };
    }
  }
}

function ViewSwitch({ widget, height }: { widget: Widget; height: number }) {
  switch (widget.kind) {
    case "text": {
      return <TextWidgetView widget={widget} height={height} />;
    }
    case "stat": {
      return <StatWidgetView widget={widget} height={height} />;
    }
    case "table": {
      return <TableWidgetView widget={widget} height={height} />;
    }
    case "chart": {
      return <ChartWidgetView widget={widget} height={height} />;
    }
    case "map": {
      return <MapWidgetView widget={widget} height={height} />;
    }
  }
}

/**
 * One widget's body. Each widget sits behind its own error boundary: a
 * dataset read denied mid-session (the viewer lost access) or a deleted
 * dataset degrades that one widget, never the app.
 */
export function WidgetView({ widget, height }: { widget: Widget; height: number }) {
  return (
    <QueryErrorBoundary
      resetKey={JSON.stringify(widget)}
      fallback={<WidgetMessage>This widget couldn't load its data.</WidgetMessage>}
    >
      <Suspense fallback={<WidgetMessage loading>Loading…</WidgetMessage>}>
        <ViewSwitch widget={widget} height={height} />
      </Suspense>
    </QueryErrorBoundary>
  );
}

/** One widget's settings form (the builder's inspector). */
export function WidgetSettings({
  widget,
  datasetIds,
  onChange,
}: {
  widget: Widget;
  datasetIds: readonly string[];
  onChange: (next: Widget) => void;
}) {
  const settings = (() => {
    switch (widget.kind) {
      case "text": {
        return <TextWidgetSettings widget={widget} datasetIds={datasetIds} onChange={onChange} />;
      }
      case "stat": {
        return <StatWidgetSettings widget={widget} datasetIds={datasetIds} onChange={onChange} />;
      }
      case "table": {
        return <TableWidgetSettings widget={widget} datasetIds={datasetIds} onChange={onChange} />;
      }
      case "chart": {
        return <ChartWidgetSettings widget={widget} datasetIds={datasetIds} onChange={onChange} />;
      }
      case "map": {
        return <MapWidgetSettings widget={widget} datasetIds={datasetIds} onChange={onChange} />;
      }
    }
  })();
  return <Suspense fallback={<WidgetMessage loading>Loading…</WidgetMessage>}>{settings}</Suspense>;
}
