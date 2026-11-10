import type { Measure } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Plus, Trash2 } from "lucide-react";

import { MEASURE_FNS, MEASURE_LABELS, type EditableMeasureFn } from "../lib/view-model";
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

/**
 * The measure rows of a summarize join or a group-by: output name, function,
 * the field it reads (count needs none) and the value to use when nothing
 * matched.
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
            className="w-40"
            onChange={(fn) => {
              if (isEditableFn(fn)) {
                const { field: _field, ...rest } = measure;
                onChange(
                  measures.map((m, i) =>
                    i === index ? (fn === "count" ? { ...rest, fn } : { ...m, fn }) : m,
                  ),
                );
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
