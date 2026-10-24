import { BarChart3, Table2 } from "lucide-react";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "#/components/ui/button";
import { useColorScheme } from "#/hooks/use-color-scheme";

import { useDatasetRecords } from "../data";
import {
  AGGREGATE_LABELS,
  formatNumber,
  formatNumberFull,
  groupRows,
  OTHER_LABEL,
  type ChartGroup,
} from "../lib/aggregate";
import { numericFields } from "../lib/fields";
import { CATEGORICAL, CATEGORICAL_LIMIT, OTHER_COLOR } from "./chart-palette";
import {
  AggregateSelect,
  DatasetSelect,
  FieldSelect,
  SettingsSelect,
  useDatasetFields,
  WidgetMessage,
  WithDataset,
  type WidgetOf,
  type WidgetSettingsProps,
  type WidgetViewProps,
} from "./shared";

/**
 * Charts over one dataset: rows grouped by a field and aggregated
 * client-side (`groupRows`), drawn with Recharts. Loaded lazily by the
 * registry, so Recharts never weighs on pages without a chart.
 *
 * Mark specs follow the dataviz method: one series → one color (no legend;
 * the title names it), thin marks with 4px rounded data-ends, 2px lines,
 * recessive horizontal grid, text in text tokens, hover tooltips on every
 * mark, and a table view of the same numbers one click away.
 */

type Scheme = "light" | "dark";

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 11 },
  GRID_STROKE = "var(--border)";

function measureLabel(widget: WidgetOf<"chart">): string {
  return widget.aggregate === "count"
    ? "Rows"
    : `${AGGREGATE_LABELS[widget.aggregate]} of ${widget.valueField ?? "—"}`;
}

function ChartTooltip({
  active,
  label,
  value,
  measure,
}: {
  active: boolean;
  label: string | undefined;
  value: number | undefined;
  measure: string;
}) {
  if (!active || value === undefined) {
    return null;
  }
  return (
    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      <div className="font-medium">{label}</div>
      <div className="text-muted-foreground">
        {measure}: <span className="text-foreground tabular-nums">{formatNumberFull(value)}</span>
      </div>
    </div>
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads the hovered point (one `ChartGroup`) out of Recharts' loosely typed tooltip payload. */
function hoveredPoint(payload: unknown): { label?: string; value?: number } {
  const first: unknown = Array.isArray(payload) ? payload[0] : undefined,
    point: unknown = isObject(first) ? first.payload : undefined;
  if (!isObject(point)) {
    return {};
  }
  return {
    label: typeof point.label === "string" ? point.label : undefined,
    value: typeof point.value === "number" ? point.value : undefined,
  };
}

function tooltipFor(measure: string) {
  return (props: { active?: boolean; payload?: unknown }) => {
    const { label, value } = hoveredPoint(props.payload);
    return (
      <ChartTooltip active={props.active === true} label={label} value={value} measure={measure} />
    );
  };
}

/** Long or many category labels read better as horizontal bars. */
function prefersHorizontal(groups: readonly ChartGroup[]): boolean {
  return groups.length > 10 || groups.some((group) => group.label.length > 14);
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function BarView({
  groups,
  color,
  measure,
}: {
  groups: ChartGroup[];
  color: string;
  measure: string;
}) {
  const horizontal = prefersHorizontal(groups);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={groups}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ bottom: 4, left: 4, right: 16, top: 8 }}
        barCategoryGap={2}
      >
        <CartesianGrid
          stroke={GRID_STROKE}
          strokeDasharray="0"
          horizontal={!horizontal}
          vertical={horizontal}
        />
        {horizontal ? (
          <>
            <XAxis
              type="number"
              tick={AXIS_TICK}
              tickFormatter={formatNumber}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={120}
              tick={AXIS_TICK}
              tickFormatter={(label: string) => truncateLabel(label, 18)}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <YAxis
              tick={AXIS_TICK}
              tickFormatter={formatNumber}
              axisLine={false}
              tickLine={false}
              width={48}
            />
          </>
        )}
        <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={tooltipFor(measure)} />
        <Bar
          dataKey="value"
          fill={color}
          radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
          maxBarSize={48}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

function SeriesView({
  groups,
  color,
  measure,
  area,
}: {
  groups: ChartGroup[];
  color: string;
  measure: string;
  area: boolean;
}) {
  const axes = (
    <>
      <CartesianGrid stroke={GRID_STROKE} vertical={false} />
      <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} minTickGap={16} />
      <YAxis
        tick={AXIS_TICK}
        tickFormatter={formatNumber}
        axisLine={false}
        tickLine={false}
        width={48}
      />
      <Tooltip
        cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
        content={tooltipFor(measure)}
      />
    </>
  );
  const margin = { bottom: 4, left: 4, right: 16, top: 8 },
    dot =
      groups.length <= 24 ? { fill: color, r: 4, stroke: "var(--card)", strokeWidth: 2 } : false;
  return (
    <ResponsiveContainer width="100%" height="100%">
      {area ? (
        <AreaChart data={groups} margin={margin}>
          {axes}
          <Area
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            fill={color}
            fillOpacity={0.15}
            dot={dot}
            isAnimationActive={false}
          />
        </AreaChart>
      ) : (
        <LineChart data={groups} margin={margin}>
          {axes}
          <Line
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={dot}
            isAnimationActive={false}
          />
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}

function sliceColor(label: string, index: number, scheme: Scheme): string {
  return label === OTHER_LABEL ? OTHER_COLOR[scheme] : CATEGORICAL[scheme][index];
}

function DonutView({
  groups,
  scheme,
  measure,
}: {
  groups: ChartGroup[];
  scheme: Scheme;
  measure: string;
}) {
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  return (
    <div className="flex h-full items-center gap-4 px-3">
      <div className="h-full min-w-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={tooltipFor(measure)} />
            <Pie
              data={groups}
              dataKey="value"
              nameKey="label"
              innerRadius="58%"
              outerRadius="88%"
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {groups.map((group, index) => (
                <Cell key={group.label} fill={sliceColor(group.label, index, scheme)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* Legend + direct labels: identity is never color alone. */}
      <ul className="flex max-h-full w-2/5 min-w-32 flex-col gap-1 overflow-y-auto text-xs">
        {groups.map((group, index) => (
          <li key={group.label} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: sliceColor(group.label, index, scheme) }}
            />
            <span className="min-w-0 flex-1 truncate" title={group.label}>
              {group.label}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {total > 0 ? `${Math.round((group.value / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DataTableView({
  groups,
  groupBy,
  measure,
}: {
  groups: ChartGroup[];
  groupBy: string;
  measure: string;
}) {
  return (
    <div className="h-full overflow-auto px-4 pt-7 pb-3">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card text-left text-muted-foreground">
          <tr>
            <th className="py-1.5 font-medium">{groupBy}</th>
            <th className="py-1.5 text-right font-medium">{measure}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.label} className="border-t border-border">
              <td className="py-1.5">{group.label}</td>
              <td className="py-1.5 text-right tabular-nums">{formatNumberFull(group.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The chart itself, by type. */
function ChartMarks({
  widget,
  groups,
  scheme,
  measure,
}: {
  widget: WidgetOf<"chart">;
  groups: ChartGroup[];
  scheme: Scheme;
  measure: string;
}) {
  const color = CATEGORICAL[scheme][0];
  switch (widget.chartType) {
    case "bar": {
      return <BarView groups={groups} color={color} measure={measure} />;
    }
    case "donut": {
      return <DonutView groups={groups} scheme={scheme} measure={measure} />;
    }
    default: {
      return (
        <SeriesView
          groups={groups}
          color={color}
          measure={measure}
          area={widget.chartType === "area"}
        />
      );
    }
  }
}

function ChartBody({ widget, groupBy }: { widget: WidgetOf<"chart">; groupBy: string }) {
  const { records, complete } = useDatasetRecords(widget.datasetId),
    scheme = useColorScheme(),
    [showTable, setShowTable] = useState(false);
  if (!complete) {
    return <WidgetMessage loading>Loading {records.length.toLocaleString()} rows…</WidgetMessage>;
  }
  const limit =
      widget.chartType === "donut" ? Math.min(widget.limit, CATEGORICAL_LIMIT) : widget.limit,
    groups = groupRows(records, {
      aggregate: widget.aggregate,
      groupBy,
      limit,
      sort: widget.sort,
      valueField: widget.valueField,
    }),
    measure = measureLabel(widget);
  if (groups.length === 0) {
    return <WidgetMessage>No values to chart yet.</WidgetMessage>;
  }
  return (
    <div className="relative h-full">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-0 right-2 z-10 text-muted-foreground"
        aria-label={showTable ? "Show chart" : "Show data table"}
        title={showTable ? "Show chart" : "Show data table"}
        onClick={() => {
          setShowTable((prev) => !prev);
        }}
      >
        {showTable ? <BarChart3 /> : <Table2 />}
      </Button>
      {showTable ? (
        <DataTableView groups={groups} groupBy={groupBy} measure={measure} />
      ) : (
        <div className="h-full pt-7 pr-2 pb-2">
          <ChartMarks widget={widget} groups={groups} scheme={scheme} measure={measure} />
        </div>
      )}
    </div>
  );
}

export function ChartWidgetView({ widget }: WidgetViewProps<"chart">) {
  const { groupBy } = widget;
  if (groupBy === undefined) {
    return <WidgetMessage>Pick a field to group by.</WidgetMessage>;
  }
  if (widget.aggregate !== "count" && widget.valueField === undefined) {
    return <WidgetMessage>Pick a field to measure.</WidgetMessage>;
  }
  return (
    <WithDataset datasetId={widget.datasetId}>
      {() => <ChartBody widget={widget} groupBy={groupBy} />}
    </WithDataset>
  );
}

const CHART_TYPES = [
  { label: "Bar", value: "bar" },
  { label: "Line", value: "line" },
  { label: "Area", value: "area" },
  { label: "Donut", value: "donut" },
] as const;

const SORTS = [
  { label: "Largest first", value: "value-desc" },
  { label: "By label (A→Z, 1→9)", value: "label-asc" },
] as const;

const LIMITS = [5, 7, 10, 15, 20, 30, 50].map((limit) => ({
  label: String(limit),
  value: String(limit),
}));

export function ChartWidgetSettings({
  widget,
  datasetIds,
  onChange,
}: WidgetSettingsProps<"chart">) {
  const fields = useDatasetFields(widget.datasetId),
    numeric = numericFields(fields);
  return (
    <>
      <DatasetSelect
        id={`chart-dataset-${widget.id}`}
        datasetIds={datasetIds}
        value={widget.datasetId}
        onChange={(datasetId) => {
          onChange({ ...widget, datasetId, groupBy: undefined, valueField: undefined });
        }}
      />
      <SettingsSelect
        id={`chart-type-${widget.id}`}
        label="Chart type"
        value={widget.chartType}
        options={CHART_TYPES}
        onChange={(value) => {
          const chartType = CHART_TYPES.find((option) => option.value === value);
          if (chartType !== undefined) {
            // Time-like series read left to right; bars and donuts by size.
            const sort =
              chartType.value === "line" || chartType.value === "area" ? "label-asc" : "value-desc";
            // Donuts name at most CATEGORICAL_LIMIT slices.
            const limit =
              chartType.value === "donut"
                ? Math.min(widget.limit, CATEGORICAL_LIMIT)
                : widget.limit;
            onChange({ ...widget, chartType: chartType.value, limit, sort });
          }
        }}
      />
      <FieldSelect
        id={`chart-group-${widget.id}`}
        label={widget.chartType === "line" || widget.chartType === "area" ? "X axis" : "Group by"}
        fields={fields}
        value={widget.groupBy}
        onChange={(groupBy) => {
          onChange({ ...widget, groupBy });
        }}
      />
      <AggregateSelect
        id={`chart-aggregate-${widget.id}`}
        value={widget.aggregate}
        onChange={(aggregate) => {
          onChange({ ...widget, aggregate });
        }}
      />
      {widget.aggregate !== "count" && (
        <FieldSelect
          id={`chart-value-${widget.id}`}
          label="Value field"
          fields={numeric.length > 0 ? numeric : fields}
          value={widget.valueField}
          onChange={(valueField) => {
            onChange({ ...widget, valueField });
          }}
        />
      )}
      <SettingsSelect
        id={`chart-sort-${widget.id}`}
        label="Order"
        value={widget.sort}
        options={SORTS}
        onChange={(value) => {
          const sort = SORTS.find((option) => option.value === value);
          if (sort !== undefined) {
            onChange({ ...widget, sort: sort.value });
          }
        }}
      />
      <SettingsSelect
        id={`chart-limit-${widget.id}`}
        label={
          widget.chartType === "donut"
            ? "Slices (max 7, rest → Other)"
            : "Most groups shown (rest → Other)"
        }
        value={String(widget.limit)}
        options={LIMITS}
        onChange={(value) => {
          onChange({ ...widget, limit: Number(value) });
        }}
      />
    </>
  );
}
