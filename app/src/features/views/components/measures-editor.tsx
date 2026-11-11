import type { Measure } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Plus, Trash2 } from "lucide-react";

import {
  MEASURE_FNS,
  MEASURE_LABELS,
  measureWithFn,
  type EditableMeasureFn,
} from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";

function isEditableFn(fn: string): fn is EditableMeasureFn {
  return MEASURE_FNS.some((known) => known === fn);
}

/** An empty-value text as the measure stores it: blank = none, numeric text = number. */
function emptyValueOf(raw: string): Measure["emptyValue"] {
  if (raw.trim() === "") {
    return undefined;
  }
  return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
}

function MeasureExtras({
  fields,
  index,
  measure,
  update,
}: {
  fields: string[];
  index: number;
  measure: Measure;
  update: (patch: Partial<Measure>) => void;
}) {
  if (measure.fn === "topBy") {
    return (
      <>
        <span className="text-xs text-muted-foreground">from the row with the</span>
        <LabeledSelect
          ariaLabel={`Measure ${index + 1} direction`}
          className="w-28"
          onChange={(direction) => {
            if (direction === "max" || direction === "min") {
              update({ direction });
            }
          }}
          options={[
            { value: "max", label: "highest" },
            { value: "min", label: "lowest" },
          ]}
          placeholder="Highest"
          value={measure.direction ?? "max"}
        />
        <LabeledSelect
          ariaLabel={`Measure ${index + 1} ranked by`}
          className="w-40"
          onChange={(by) => {
            update({ by });
          }}
          options={fields.map((field) => ({ value: field, label: field }))}
          placeholder="Ranked by"
          value={measure.by ?? ""}
        />
      </>
    );
  }
  if (measure.fn === "text") {
    return (
      <Input
        aria-label={`Measure ${index + 1} separator`}
        className="w-24"
        onChange={(event) => {
          update({ separator: event.target.value });
        }}
        placeholder="Separator"
        value={measure.separator ?? ""}
      />
    );
  }
  return null;
}

/**
 * The measure rows of a summarize join or a group-by: output name, function,
 * the field it reads (count needs none), the extra settings of "value from
 * the top row" (which field ranks the rows, highest or lowest) and "join as
 * text" (the separator), and the value to use when nothing matched.
 */
export function MeasuresEditor({
  fields,
  measures,
  onChange,
}: {
  /** Fields the measures may read (the right side for a join, the current row for group-by). */
  fields: string[];
  measures: Measure[];
  onChange: (measures: Measure[]) => void;
}) {
  const update = (index: number, patch: Partial<Measure>): void => {
    onChange(measures.map((measure, i) => (i === index ? { ...measure, ...patch } : measure)));
  };
  return (
    <div className="flex flex-col gap-2">
      {measures.map((measure, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- measures are an ordered, unkeyed list.
        <div className="flex flex-wrap items-center gap-2" key={index}>
          <Input
            aria-label={`Measure ${index + 1} name`}
            className="w-36"
            onChange={(event) => {
              update(index, { as: event.target.value });
            }}
            placeholder="Output name"
            value={measure.as}
          />
          <LabeledSelect
            ariaLabel={`Measure ${index + 1} function`}
            className="w-52"
            onChange={(fn) => {
              if (isEditableFn(fn)) {
                onChange(measures.map((m, i) => (i === index ? measureWithFn(m, fn) : m)));
              }
            }}
            options={MEASURE_FNS.map((fn) => ({ value: fn, label: MEASURE_LABELS[fn] }))}
            placeholder="Function"
            value={measure.fn}
          />
          {measure.fn !== "count" && (
            <LabeledSelect
              ariaLabel={`Measure ${index + 1} field`}
              className="w-44"
              onChange={(field) => {
                update(index, { field });
              }}
              options={fields.map((field) => ({ value: field, label: field }))}
              placeholder="Field"
              value={measure.field ?? ""}
            />
          )}
          <MeasureExtras
            fields={fields}
            index={index}
            measure={measure}
            update={(patch) => {
              update(index, patch);
            }}
          />
          <Input
            aria-label={`Measure ${index + 1} value when nothing matched`}
            className="w-32"
            onChange={(event) => {
              const next = emptyValueOf(event.target.value);
              const { emptyValue: _old, ...rest } = measure;
              onChange(
                measures.map((m, i) =>
                  i === index ? (next === undefined ? rest : { ...rest, emptyValue: next }) : m,
                ),
              );
            }}
            placeholder={measure.fn === "count" ? "Empty: 0" : "Empty: none"}
            value={
              measure.emptyValue === undefined || measure.emptyValue === null
                ? ""
                : String(measure.emptyValue)
            }
          />
          <Button
            aria-label={`Remove measure ${index + 1}`}
            onClick={() => {
              onChange(measures.filter((_, i) => i !== index));
            }}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        className="w-fit"
        onClick={() => {
          onChange([...measures, { as: `measure_${measures.length + 1}`, fn: "count" }]);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="h-3.5 w-3.5" />
        Add measure
      </Button>
    </div>
  );
}
