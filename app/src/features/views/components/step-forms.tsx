import type {
  ConditionLeaf,
  ConditionOp,
  JoinStep,
  MultiMatch,
  Step,
} from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Checkbox } from "@caden/ui/components/checkbox";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  defaultMeasure,
  FILTER_OPS,
  filterLeaves,
  filterValue,
  filterValueText,
  leavesToWhere,
  rightFieldsOf,
  withoutManualMapEntry,
  type InputInfo,
} from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";
import { MeasuresEditor } from "./measures-editor";
import { SpreadEditor } from "./spread-editor";

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

const MULTI_MATCH_OPTIONS = [
  { value: "first", label: "Take the first match" },
  { value: "last", label: "Take the last match" },
  { value: "summarize", label: "Summarize them (count, sum, ...)" },
  { value: "spread", label: "Spread into columns (one per category)" },
  { value: "text", label: "Join into one text value" },
  { value: "list", label: "Keep as a list (arrays, opt-in)" },
  { value: "error", label: "Stop with an error" },
];

/** The multi-match a freshly chosen mode starts with. */
function startingMultiMatch(mode: string): MultiMatch | undefined {
  switch (mode) {
    case "first":
    case "last":
      return { mode };
    case "summarize":
      return { mode, measures: [defaultMeasure("matches")] };
    case "spread":
      return { mode, by: "", value: "", columns: [] };
    case "text":
      return { mode, field: "", separator: ", " };
    case "list":
    case "error":
      return { mode };
    default:
      return undefined;
  }
}

const MODE_HINTS: Partial<Record<MultiMatch["mode"], string>> = {
  list: "Puts every matching row into one array field. Arrays do not flatten into a GIS table, so use this only when you want nested data.",
  error:
    "Fails the run, naming the key, when any row has several matches. Use it to prove a join is one-to-one.",
};

function MultiMatchEditor({
  existingFields,
  onChange,
  rightDatasetId,
  rightFields,
  step,
  undeclared,
}: {
  existingFields: string[];
  onChange: (multiMatch: MultiMatch) => void;
  rightDatasetId: string;
  rightFields: string[];
  step: JoinStep;
  undeclared: string[];
}) {
  const { multiMatch } = step;
  if (multiMatch.mode === "summarize") {
    return (
      <div className="flex flex-col gap-2">
        <Label>Measures over the matching rows</Label>
        <MeasuresEditor
          fields={rightFields}
          measures={multiMatch.measures}
          onChange={(measures) => {
            onChange({ mode: "summarize", measures });
          }}
        />
      </div>
    );
  }
  if (multiMatch.mode === "spread") {
    return (
      <SpreadEditor
        existingFields={existingFields}
        onChange={onChange}
        rightDatasetId={rightDatasetId}
        rightFields={rightFields}
        spread={multiMatch}
        undeclared={undeclared}
      />
    );
  }
  if (multiMatch.mode === "text") {
    return (
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-2">
          <Label>Field to join as text</Label>
          <LabeledSelect
            ariaLabel="Text field"
            className="w-56"
            onChange={(field) => {
              onChange({ ...multiMatch, field });
            }}
            options={fieldOptions(rightFields)}
            placeholder="Field"
            value={multiMatch.field}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="join-separator">Separator</Label>
          <Input
            className="w-32"
            id="join-separator"
            onChange={(event) => {
              onChange({ ...multiMatch, separator: event.target.value });
            }}
            value={multiMatch.separator}
          />
        </div>
      </div>
    );
  }
  return null;
}

/** Join: the right dataset, key pairs, key matching, join type and the multi-match policy. */
export function JoinForm({
  datasets,
  infos,
  leftFields,
  onChange,
  onPickRight,
  step,
  subSteps,
  undeclaredCategories = [],
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
  /** The "steps on the right input" section (the step list wires it in; absent = not offered). */
  subSteps?: ReactNode;
  /** Spread categories the diagnostics found with no declared column. */
  undeclaredCategories?: string[];
}) {
  const right = infos.find((info) => info.alias === step.right.input),
    rightFields = rightFieldsOf(step, infos) ?? [],
    rightDatasetId = right === undefined ? "" : right.datasetId,
    { multiMatch } = step,
    copiesRows = multiMatch.mode !== "summarize" && multiMatch.mode !== "spread";
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
        {subSteps}
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
              const next = startingMultiMatch(mode);
              if (next !== undefined && next.mode !== multiMatch.mode) {
                onChange({ ...step, multiMatch: next });
              }
            }}
            options={MULTI_MATCH_OPTIONS}
            placeholder="Policy"
            value={multiMatch.mode}
          />
        </div>
      </div>

      {MODE_HINTS[multiMatch.mode] !== undefined && (
        <p className="text-xs text-muted-foreground">{MODE_HINTS[multiMatch.mode]}</p>
      )}

      <MultiMatchEditor
        existingFields={leftFields}
        onChange={(next) => {
          onChange({ ...step, multiMatch: next });
        }}
        rightDatasetId={rightDatasetId}
        rightFields={rightFields}
        step={step}
        undeclared={undeclaredCategories}
      />

      {copiesRows && (
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
