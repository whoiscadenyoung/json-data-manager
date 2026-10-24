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
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "#/components/ui/button";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "#/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";

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
 * client-side (`groupRows`), drawn with the shadcn `Chart` kit
 * (`ChartContainer` over Recharts). Loaded lazily by the registry, so
 * Recharts never weighs on pages without a chart.
 *
 * Colors ride `ChartConfig` themes — the container emits `--color-<key>`
 * for light and dark from the dataviz palette's own steps, so marks never
 * read the color scheme themselves. Mark specs follow the dataviz method:
 * one series → one color (no legend; the title names it), 4px rounded
 * data-ends, 2px lines, a recessive horizontal grid, hover tooltips on every
 * mark, and a table view of the same numbers one click away.
 */

const MARGIN = { bottom: 4, left: 4, right: 16, top: 8 };

function measureLabel(widget: WidgetOf<"chart">): string {
  return widget.aggregate === "count"
    ? "Rows"
    : `${AGGREGATE_LABELS[widget.aggregate]} of ${widget.valueField ?? "—"}`;
}

/** The single-series config: one `--color-value` from palette slot 1, stepped per theme. */
function seriesConfig(measure: string): ChartConfig {
  return {
    value: { label: measure, theme: { dark: CATEGORICAL.dark[0], light: CATEGORICAL.light[0] } },
  };
}

/** Long or many category labels read better as horizontal bars. */
function prefersHorizontal(groups: readonly ChartGroup[]): boolean {
  return groups.length > 10 || groups.some((group) => group.label.length > 14);
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function BarView({ groups, measure }: { groups: ChartGroup[]; measure: string }) {
  const horizontal = prefersHorizontal(groups);
  return (
    <ChartContainer config={seriesConfig(measure)} className="aspect-auto size-full">
      <BarChart
        data={groups}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={MARGIN}
        barCategoryGap={2}
        accessibilityLayer
      >
        <CartesianGrid horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tickFormatter={formatNumber} axisLine={false} tickLine={false} />
            <YAxis
              type="category"
              dataKey="label"
              width={120}
              tickFormatter={(label: string) => truncateLabel(label, 18)}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
          </>
        ) : (
          <>
            <XAxis dataKey="label" axisLine={false} tickLine={false} interval={0} />
            <YAxis tickFormatter={formatNumber} axisLine={false} tickLine={false} width={48} />
          </>
        )}
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
          maxBarSize={48}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  );
}

function SeriesView({
  groups,
  measure,
  area,
}: {
  groups: ChartGroup[];
  measure: string;
  area: boolean;
}) {
  const axes = (
      <>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={16} />
        <YAxis tickFormatter={formatNumber} axisLine={false} tickLine={false} width={48} />
        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
      </>
    ),
    dot =
      groups.length <= 24
        ? { fill: "var(--color-value)", r: 4, stroke: "var(--card)", strokeWidth: 2 }
        : false;
  return (
    <ChartContainer config={seriesConfig(measure)} className="aspect-auto size-full">
      {area ? (
        <AreaChart data={groups} margin={MARGIN} accessibilityLayer>
          {axes}
          <Area
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={2}
            fill="var(--color-value)"
            fillOpacity={0.15}
            dot={dot}
            isAnimationActive={false}
          />
        </AreaChart>
      ) : (
        <LineChart data={groups} margin={MARGIN} accessibilityLayer>
          {axes}
          <Line
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={2}
            dot={dot}
            isAnimationActive={false}
          />
        </LineChart>
      )}
    </ChartContainer>
  );
}

/** A slice's config key: palette slots in fixed order, "other" for the fold. */
function sliceKey(group: ChartGroup, index: number): string {
  return group.label === OTHER_LABEL ? "other" : `slice${index}`;
}

/** A slice's share of the whole, for its legend label. */
function shareLabel(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : "—";
}

/**
 * One config entry per slice — `--color-<key>` per theme, and a label that
 * carries the share so the legend direct-labels every slice (identity is
 * never color alone).
 */
function donutConfig(groups: readonly ChartGroup[]): ChartConfig {
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  return Object.fromEntries(
    groups.map((group, index) => [
      sliceKey(group, index),
      {
        label: `${group.label} · ${shareLabel(group.value, total)}`,
        theme:
          group.label === OTHER_LABEL
            ? OTHER_COLOR
            : { dark: CATEGORICAL.dark[index], light: CATEGORICAL.light[index] },
      },
    ]),
  );
}

function DonutView({ groups }: { groups: ChartGroup[] }) {
  const slices = groups.map((group, index) => ({
    ...group,
    fill: `var(--color-${sliceKey(group, index)})`,
    key: sliceKey(group, index),
  }));
  return (
    <ChartContainer config={donutConfig(groups)} className="aspect-auto size-full">
      <PieChart accessibilityLayer>
        <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
        <Pie
          data={slices}
          dataKey="value"
          nameKey="key"
          innerRadius="58%"
          outerRadius="88%"
          stroke="var(--card)"
          strokeWidth={2}
          isAnimationActive={false}
        >
          {slices.map((slice) => (
            <Cell key={slice.key} fill={slice.fill} />
          ))}
        </Pie>
        <ChartLegend
          layout="vertical"
          align="right"
          verticalAlign="middle"
          content={<ChartLegendContent nameKey="key" className="flex-col items-start gap-1 pt-0" />}
        />
      </PieChart>
    </ChartContainer>
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
    <div className="h-full overflow-auto px-4 pb-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{groupBy}</TableHead>
            <TableHead className="text-right">{measure}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map((group) => (
            <TableRow key={group.label}>
              <TableCell>{group.label}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatNumberFull(group.value)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The chart itself, by type. */
function ChartMarks({
  widget,
  groups,
  measure,
}: {
  widget: WidgetOf<"chart">;
  groups: ChartGroup[];
  measure: string;
}) {
  switch (widget.chartType) {
    case "bar": {
      return <BarView groups={groups} measure={measure} />;
    }
    case "donut": {
      return <DonutView groups={groups} />;
    }
    default: {
      return <SeriesView groups={groups} measure={measure} area={widget.chartType === "area"} />;
    }
  }
}

function ChartBody({ widget, groupBy }: { widget: WidgetOf<"chart">; groupBy: string }) {
  const { records, complete } = useDatasetRecords(widget.datasetId),
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
    <div className="flex h-full flex-col">
      <div className="flex justify-end px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={showTable ? "Show chart" : "Show data table"}
          title={showTable ? "Show chart" : "Show data table"}
          onClick={() => {
            setShowTable((prev) => !prev);
          }}
        >
          {showTable ? <BarChart3 /> : <Table2 />}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {showTable ? (
          <DataTableView groups={groups} groupBy={groupBy} measure={measure} />
        ) : (
          <div className="h-full pr-2 pb-2">
            <ChartMarks widget={widget} groups={groups} measure={measure} />
          </div>
        )}
      </div>
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
