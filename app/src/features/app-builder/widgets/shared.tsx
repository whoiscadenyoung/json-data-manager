import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import type { Aggregate, Widget, WidgetKind } from "#convex/appBuilder/validators";

import { useAppDataset, useAppDatasets, datasetTitle, type DatasetState } from "../data";
import { AGGREGATE_LABELS } from "../lib/aggregate";
import type { DatasetField } from "../lib/fields";

/** One widget kind's narrowed config. */
export type WidgetOf<K extends WidgetKind> = Extract<Widget, { kind: K }>;

export interface WidgetViewProps<K extends WidgetKind> {
  widget: WidgetOf<K>;
  /** The widget body's height in px (the frame minus its title bar). */
  height: number;
}

export interface WidgetSettingsProps<K extends WidgetKind> {
  widget: WidgetOf<K>;
  /** The app's data sources, in order. */
  datasetIds: readonly string[];
  onChange: (next: WidgetOf<K>) => void;
}

/** A centered, quiet message filling a widget body — empty, loading, and error states. */
export function WidgetMessage({
  children,
  loading = false,
}: {
  children: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
      {loading && <Loader2 className="size-4 animate-spin text-primary" />}
      {children}
    </div>
  );
}

/** Renders `children` with the dataset's ready state, or the matching loading / unavailable message. */
export function WithDataset({
  datasetId,
  children,
}: {
  datasetId: string;
  children: (state: Extract<DatasetState, { status: "ready" }>) => ReactNode;
}) {
  const state = useAppDataset(datasetId);
  if (state.status === "loading") {
    return <WidgetMessage loading>Loading dataset…</WidgetMessage>;
  }
  if (state.status === "unavailable") {
    return (
      <WidgetMessage>
        This dataset isn't available — it may have been deleted, or it isn't shared with you.
      </WidgetMessage>
    );
  }
  return <>{children(state)}</>;
}

/** The sentinel for "no field chosen" in selects (base-ui selects take null for empty). */
export const NONE = "";

export function SettingsSelect({
  id,
  label,
  value,
  options,
  placeholder,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        disabled={disabled || options.length === 0}
        value={value === NONE ? null : value}
        items={options}
        onValueChange={(next) => {
          onChange(typeof next === "string" ? next : NONE);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Picks one of the app's datasets. */
export function DatasetSelect({
  id,
  datasetIds,
  value,
  onChange,
  filter,
}: {
  id: string;
  datasetIds: readonly string[];
  value: string;
  onChange: (datasetId: string) => void;
  filter?: (state: DatasetState) => boolean;
}) {
  const states = useAppDatasets(),
    options = datasetIds.flatMap((datasetId) => {
      const state = states.get(datasetId) ?? { status: "unavailable" as const };
      if (filter !== undefined && !filter(state)) {
        return [];
      }
      return [{ label: datasetTitle(state), value: datasetId }];
    });
  return (
    <SettingsSelect
      id={id}
      label="Dataset"
      value={value}
      options={options}
      placeholder={options.length === 0 ? "Add a dataset to the app first" : "Choose a dataset"}
      onChange={onChange}
    />
  );
}

/** Picks a field of the widget's dataset. */
export function FieldSelect({
  id,
  label,
  fields,
  value,
  onChange,
  placeholder = "Choose a field",
}: {
  id: string;
  label: string;
  fields: readonly DatasetField[];
  value: string | undefined;
  onChange: (field: string | undefined) => void;
  placeholder?: string;
}) {
  return (
    <SettingsSelect
      id={id}
      label={label}
      value={value ?? NONE}
      options={fields.map((field) => ({ label: field.name, value: field.name }))}
      placeholder={placeholder}
      onChange={(next) => {
        onChange(next === NONE ? undefined : next);
      }}
    />
  );
}

const AGGREGATES: Aggregate[] = ["count", "sum", "avg", "min", "max"];

export function AggregateSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Aggregate;
  onChange: (aggregate: Aggregate) => void;
}) {
  return (
    <SettingsSelect
      id={id}
      label="Measure"
      value={value}
      options={AGGREGATES.map((aggregate) => ({
        label: aggregate === "count" ? "Count of rows" : AGGREGATE_LABELS[aggregate],
        value: aggregate,
      }))}
      onChange={(next) => {
        const found = AGGREGATES.find((aggregate) => aggregate === next);
        if (found !== undefined) {
          onChange(found);
        }
      }}
    />
  );
}

/** The fields a dataset-bound widget's settings can offer, from the app's resolved datasets. */
export function useDatasetFields(datasetId: string): readonly DatasetField[] {
  const state = useAppDataset(datasetId);
  return state.status === "ready" ? state.fields : [];
}
