import type { ConditionLeaf, ConditionOp, JoinStep, Step } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Checkbox } from "@caden/ui/components/checkbox";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Plus, Trash2 } from "lucide-react";

import {
  defaultMeasure,
  FILTER_OPS,
  filterLeaves,
  filterValue,
  filterValueText,
  leavesToWhere,
  withoutManualMapEntry,
  type InputInfo,
} from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";
import { MeasuresEditor } from "./measures-editor";

const fieldOptions = (fields: string[]) => fields.map((field) => ({ value: field, label: field }));

function isOp(value: string): value is ConditionOp {
  return FILTER_OPS.some((entry) => entry.op === value);
}

/** Filter rows: every condition must hold (an AND of simple conditions). */
export function FilterForm({
  fields,
  onChange,
  step,
}: {
  fields: string[];
  onChange: (step: Step) => void;
  step: Extract<Step, { kind: "filter" }>;
}) {
  const leaves = filterLeaves(step.where);
  if (leaves === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        This filter uses nested conditions, which the form cannot edit yet. It still runs as saved.
      </p>
    );
  }
  const commit = (next: ConditionLeaf[]): void => {
    onChange({ kind: "filter", where: leavesToWhere(next) });
  };
  const update = (index: number, patch: Partial<ConditionLeaf>): void => {
    commit(leaves.map((leaf, i) => (i === index ? { ...leaf, ...patch } : leaf)));
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Keep only rows where all of these hold.</p>
      {leaves.map((leaf, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- conditions are an ordered, unkeyed list.
        <div className="flex flex-wrap items-center gap-2" key={index}>
          <LabeledSelect
            ariaLabel={`Condition ${index + 1} field`}
            className="w-44"
            onChange={(field) => {
              update(index, { field });
            }}
            options={fieldOptions(fields)}
            placeholder="Field"
            value={leaf.field}
          />
          <LabeledSelect
            ariaLabel={`Condition ${index + 1} operator`}
            className="w-36"
            onChange={(op) => {
              if (isOp(op)) {
                const { value: _old, ...rest } = leaf;
                const text = filterValueText(leaf);
                const value = filterValue(op, text);
                commit(
                  leaves.map((l, i) =>
                    i === index
                      ? value === undefined
                        ? { ...rest, op }
                        : { ...rest, op, value }
                      : l,
                  ),
                );
              }
            }}
            options={FILTER_OPS.map((entry) => ({ value: entry.op, label: entry.label }))}
            placeholder="Operator"
            value={leaf.op}
          />
          {leaf.op !== "isNull" && leaf.op !== "notNull" && (
            <Input
              aria-label={`Condition ${index + 1} value`}
              className="w-44"
              onChange={(event) => {
                update(index, { value: filterValue(leaf.op, event.target.value) });
              }}
              placeholder={leaf.op === "in" ? "a, b, c" : "Value"}
              value={filterValueText(leaf)}
            />
          )}
          <Button
            aria-label={`Remove condition ${index + 1}`}
            disabled={leaves.length === 1}
            onClick={() => {
              commit(leaves.filter((_, i) => i !== index));
            }}
            size="icon-sm"
            title={leaves.length === 1 ? "A filter needs at least one condition." : undefined}
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
          commit([...leaves, { field: "", op: "eq", value: "" }]);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="h-3.5 w-3.5" />
        Add condition
      </Button>
    </div>
  );
}

/** Group by: the grouping fields and the measures computed per group. */
export function GroupByForm({
  fields,
  onChange,
  step,
}: {
  fields: string[];
  onChange: (step: Step) => void;
  step: Extract<Step, { kind: "groupBy" }>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label>Group by</Label>
        {step.by.map((field, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- grouping fields are an ordered, unkeyed list.
          <div className="flex items-center gap-2" key={index}>
            <LabeledSelect
              ariaLabel={`Group field ${index + 1}`}
              className="w-56"
              onChange={(next) => {
                onChange({ ...step, by: step.by.map((f, i) => (i === index ? next : f)) });
              }}
              options={fieldOptions(fields)}
              placeholder="Field"
              value={field}
            />
            <Button
              aria-label={`Remove group field ${index + 1}`}
              disabled={step.by.length === 1}
              onClick={() => {
                onChange({ ...step, by: step.by.filter((_, i) => i !== index) });
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
            onChange({ ...step, by: [...step.by, ""] });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-3.5 w-3.5" />
          Add field
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Measures</Label>
        <MeasuresEditor
          fields={fields}
          measures={step.measures}
          onChange={(measures) => {
            onChange({ ...step, measures });
          }}
        />
      </div>
    </div>
  );
}

const MATCH_FLAGS: {
  key: keyof Omit<JoinStep["matching"], "manualMap">;
  label: string;
  hint: string;
}[] = [
  { key: "trim", label: "Trim spaces", hint: "Ignore spaces at the start and end." },
  { key: "caseFold", label: "Ignore case", hint: "Treat Kansas and KANSAS as the same." },
  { key: "collapseSpace", label: "Collapse spaces", hint: "Treat runs of spaces as one." },
  { key: "stripDiacritics", label: "Ignore accents", hint: "Treat Zoë and Zoe as the same." },
];

/** Join: the right dataset, key pairs, key matching, join type and the multi-match policy. */
export function JoinForm({
  datasets,
  infos,
  leftFields,
  onChange,
  onPickRight,
  step,
}: {
  /** Datasets the right side may be (titles, never ids). */
  datasets: { id: string; title: string }[];
  infos: InputInfo[];
  /** Fields in the rows reaching this step. */
  leftFields: string[];
  onChange: (step: JoinStep) => void;
  /** The page adds the input (or reuses one) and re-points the step. */
  onPickRight: (datasetId: string) => void;
  step: JoinStep;
}) {
  const right = infos.find((info) => info.alias === step.right.input),
    rightFields = right === undefined ? [] : right.fields,
    rightDatasetId = right === undefined ? "" : right.datasetId,
    { multiMatch } = step;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label>Join with</Label>
        <LabeledSelect
          ariaLabel="Right dataset"
          className="w-72"
          onChange={onPickRight}
          options={datasets.map((dataset) => ({ value: dataset.id, label: dataset.title }))}
          placeholder="Pick a dataset or view"
          value={rightDatasetId}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Where these fields match</Label>
        {step.on.map((pair, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- key pairs are an ordered, unkeyed list.
          <div className="flex flex-wrap items-center gap-2" key={index}>
            <LabeledSelect
              ariaLabel={`Key ${index + 1} left field`}
              className="w-48"
              onChange={(left) => {
                onChange({
                  ...step,
                  on: step.on.map((p, i) => (i === index ? { ...p, left } : p)),
                });
              }}
              options={fieldOptions(leftFields)}
              placeholder="This table's field"
              value={pair.left}
            />
            <span className="text-sm text-muted-foreground">=</span>
            <LabeledSelect
              ariaLabel={`Key ${index + 1} right field`}
              className="w-48"
              onChange={(rightField) => {
                onChange({
                  ...step,
                  on: step.on.map((p, i) => (i === index ? { ...p, right: rightField } : p)),
                });
              }}
              options={fieldOptions(rightFields)}
              placeholder={right === undefined ? "Pick a dataset first" : `${right.title}'s field`}
              value={pair.right}
            />
            <Button
              aria-label={`Remove key pair ${index + 1}`}
              disabled={step.on.length === 1}
              onClick={() => {
                onChange({ ...step, on: step.on.filter((_, i) => i !== index) });
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
            onChange({ ...step, on: [...step.on, { left: "", right: "" }] });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-3.5 w-3.5" />
          Add key pair
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <Label>How keys are compared</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {MATCH_FLAGS.map((flag) => (
            <label className="flex items-start gap-2 text-sm" key={flag.key}>
              <Checkbox
                checked={step.matching[flag.key]}
                onCheckedChange={(checked) => {
                  onChange({
                    ...step,
                    matching: { ...step.matching, [flag.key]: checked },
                  });
                }}
              />
              <span>
                {flag.label}
                <span className="block text-xs text-muted-foreground">{flag.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {(step.matching.manualMap ?? []).length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground">Manual key map</p>
            {(step.matching.manualMap ?? []).map((entry) => (
              <div className="flex items-center gap-2 text-sm" key={entry.from}>
                <code className="rounded bg-muted px-1.5 py-0.5">{entry.from}</code>
                <span className="text-muted-foreground">matches</span>
                <code className="rounded bg-muted px-1.5 py-0.5">{entry.to}</code>
                <Button
                  aria-label={`Remove map entry ${entry.from}`}
                  onClick={() => {
                    onChange(withoutManualMapEntry(step, entry.from));
                  }}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Rows to keep</Label>
          <LabeledSelect
            ariaLabel="Join type"
            onChange={(type) => {
              if (type === "left" || type === "inner") {
                onChange({ ...step, type });
              }
            }}
            options={[
              { value: "left", label: "All rows from this table" },
              { value: "inner", label: "Only rows that match" },
            ]}
            placeholder="Join type"
            value={step.type}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>When several rows match</Label>
          <LabeledSelect
            ariaLabel="Multi-match policy"
            onChange={(mode) => {
              if (mode === "first" || mode === "last") {
                onChange({ ...step, multiMatch: { mode } });
              } else if (mode === "summarize") {
                onChange({
                  ...step,
                  multiMatch: { mode, measures: [defaultMeasure("matches")] },
                });
              }
            }}
            options={[
              { value: "first", label: "Take the first match" },
              { value: "last", label: "Take the last match" },
              { value: "summarize", label: "Summarize them (count, sum, ...)" },
            ]}
            placeholder="Policy"
            value={multiMatch.mode}
          />
        </div>
      </div>

      {multiMatch.mode === "summarize" ? (
        <div className="flex flex-col gap-2">
          <Label>Measures over the matching rows</Label>
          <MeasuresEditor
            fields={rightFields}
            measures={multiMatch.measures}
            onChange={(measures) => {
              onChange({ ...step, multiMatch: { mode: "summarize", measures } });
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="join-prefix">Name prefix for joined fields</Label>
          <Input
            className="w-64"
            id="join-prefix"
            onChange={(event) => {
              onChange({ ...step, prefix: event.target.value });
            }}
            value={step.prefix ?? ""}
          />
          <p className="text-xs text-muted-foreground">
            Joined fields are named prefix.field. It defaults to the dataset&apos;s title.
          </p>
        </div>
      )}
    </div>
  );
}
