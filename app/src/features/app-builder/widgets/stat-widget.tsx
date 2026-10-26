import { useDatasetRecords } from "../data";
import { AGGREGATE_LABELS, computeStat, formatNumberFull, formatStatValue } from "../lib/aggregate";
import { numericFields } from "../lib/fields";
import {
  AggregateSelect,
  DatasetSelect,
  FieldSelect,
  useDatasetFields,
  WidgetMessage,
  WithDataset,
  type WidgetSettingsProps,
  type WidgetViewProps,
} from "./shared";

/** A headline number — count of rows, or a sum/average/min/max of one field. */
function StatValue({
  widget,
  title,
}: {
  widget: WidgetViewProps<"stat">["widget"];
  title: string;
}) {
  const { records, complete } = useDatasetRecords(widget.datasetId);
  if (!complete) {
    return <WidgetMessage loading>Loading {records.length.toLocaleString()} rows…</WidgetMessage>;
  }
  const value = computeStat(records, widget.aggregate, widget.field),
    caption =
      widget.aggregate === "count"
        ? `Rows in ${title}`
        : `${AGGREGATE_LABELS[widget.aggregate]} of ${widget.field ?? "—"}`;
  return (
    <div className="flex h-full flex-col justify-center gap-1 px-4 py-3">
      <span
        className="text-3xl font-semibold tracking-tight tabular-nums"
        title={value === null ? undefined : formatNumberFull(value)}
      >
        {value === null ? "—" : formatStatValue(value, widget.aggregate)}
      </span>
      <span className="truncate text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

export function StatWidgetView({ widget }: WidgetViewProps<"stat">) {
  if (widget.aggregate !== "count" && widget.field === undefined) {
    return <WidgetMessage>Pick a field to measure.</WidgetMessage>;
  }
  return (
    <WithDataset datasetId={widget.datasetId}>
      {(state) => <StatValue widget={widget} title={state.doc.title} />}
    </WithDataset>
  );
}

export function StatWidgetSettings({ widget, datasetIds, onChange }: WidgetSettingsProps<"stat">) {
  const fields = useDatasetFields(widget.datasetId),
    numeric = numericFields(fields);
  return (
    <>
      <DatasetSelect
        id={`stat-dataset-${widget.id}`}
        datasetIds={datasetIds}
        value={widget.datasetId}
        onChange={(datasetId) => {
          onChange({ ...widget, datasetId, field: undefined });
        }}
      />
      <AggregateSelect
        id={`stat-aggregate-${widget.id}`}
        value={widget.aggregate}
        onChange={(aggregate) => {
          onChange({ ...widget, aggregate });
        }}
      />
      {widget.aggregate !== "count" && (
        <FieldSelect
          id={`stat-field-${widget.id}`}
          label="Field"
          // Imported CSV columns are often declared as text — offer every
          // field when none is declared numeric.
          fields={numeric.length > 0 ? numeric : fields}
          value={widget.field}
          onChange={(field) => {
            onChange({ ...widget, field });
          }}
        />
      )}
    </>
  );
}
