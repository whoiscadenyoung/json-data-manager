import type { JoinStep, Step, ValidationError } from "@caden/data-core/views";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card, CardContent } from "@caden/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@caden/ui/components/dropdown-menu";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { stepDiagnosticsOf, type StepDiagnostics } from "../lib/diagnostics";
import {
  errorLabel,
  errorsForStep,
  fieldsThrough,
  newCalculateStep,
  newFilterStep,
  newGroupByStep,
  newJoinStep,
  newSqlStep,
  repointRight,
  stepProblem,
  stepSummary,
  STEP_TITLES,
  type InputInfo,
} from "../lib/view-model";
import { CalculateForm } from "./calculate-form";
import { SqlForm } from "./sql-form";
import { FilterForm, GroupByForm, JoinForm } from "./step-forms";

/** What every step form needs from the editor page, shared by the top-level list and nested sub-pipelines. */
export interface StepEditorContext {
  datasets: { id: string; title: string }[];
  infos: InputInfo[];
  /** Declares (or reuses) an input for a dataset and returns its alias. */
  ensureInput: (datasetId: string) => string;
  /** Every validation error of the whole definition (paths like `steps[1].right.steps[0].expr`). */
  errors: ValidationError[];
  /** The raw diagnostics payload of the current preview. */
  diagnostics: unknown;
}

export type AddableKind = "join" | "filter" | "groupBy" | "calculate" | "sql";

function undeclaredOf(diagnostics: StepDiagnostics | undefined): string[] | undefined {
  if (diagnostics === undefined || diagnostics.join === undefined) {
    return undefined;
  }
  const { spread } = diagnostics.join;
  return spread === undefined ? undefined : spread.undeclaredCategories;
}

function titleOf(infos: readonly InputInfo[], alias: string): string {
  const found = infos.find((info) => info.alias === alias);
  return found === undefined ? "" : found.title;
}

function newStepOf(kind: AddableKind, firstField: string): Step {
  switch (kind) {
    case "filter":
      return newFilterStep(firstField);
    case "groupBy":
      return newGroupByStep(firstField);
    case "calculate":
      return newCalculateStep();
    case "sql":
      return newSqlStep();
    default:
      return newJoinStep({ rightAlias: "", rightTitle: "" });
  }
}

const ADD_ITEMS: { kind: AddableKind; label: string }[] = [
  { kind: "join", label: "Join another dataset" },
  { kind: "filter", label: "Filter rows" },
  { kind: "groupBy", label: "Group and summarize" },
  { kind: "calculate", label: "Calculate a field" },
  { kind: "sql", label: "Custom SQL" },
];

export function AddStepMenu({
  disabled,
  label = "Add step",
  onAdd,
}: {
  disabled: boolean;
  label?: string;
  onAdd: (kind: AddableKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button className="w-fit" disabled={disabled} type="button" variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {ADD_ITEMS.map((item) => (
          <DropdownMenuItem
            key={item.kind}
            onClick={() => {
              onAdd(item.kind);
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepNote({ diagnostics }: { diagnostics: StepDiagnostics }) {
  return (
    <p className="mb-3 text-xs text-muted-foreground" data-testid="step-note">
      {diagnostics.rowsIn.toLocaleString()} rows in, {diagnostics.rowsOut.toLocaleString()} out
      {diagnostics.fieldsAdded.length > 0 && `. Adds ${diagnostics.fieldsAdded.join(", ")}`}
      {diagnostics.fieldsRemoved.length > 0 && `. Removes ${diagnostics.fieldsRemoved.join(", ")}`}
    </p>
  );
}

function StepCard({
  children,
  expanded,
  index,
  infos,
  kindLabel,
  messages,
  nested,
  note,
  onMove,
  onRemove,
  onSelect,
  problem,
  step,
  stepCount,
}: {
  children: React.ReactNode;
  expanded: boolean;
  index: number;
  infos: InputInfo[];
  /** "step" at the top level, "sub-step" inside a sub-pipeline (button labels stay unambiguous). */
  kindLabel: string;
  messages: string[];
  nested: boolean;
  note: StepDiagnostics | undefined;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onSelect: () => void;
  problem: string | undefined;
  step: Step;
  stepCount: number;
}) {
  const hasErrors = messages.length > 0;
  return (
    <Card
      className={
        hasErrors
          ? "border-destructive/50"
          : expanded
            ? "border-primary/40"
            : nested
              ? "bg-muted/20"
              : undefined
      }
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
          onClick={onSelect}
          type="button"
        >
          <span className="text-sm font-medium">
            {index + 1}. {STEP_TITLES[step.kind]}
          </span>
          <span className="max-w-full truncate text-xs text-muted-foreground">
            {stepSummary(step, infos)}
          </span>
        </button>
        {problem !== undefined ? (
          <Badge variant="secondary">Needs input</Badge>
        ) : (
          hasErrors && <Badge variant="destructive">Problem</Badge>
        )}
        <Button
          aria-label={`Move ${kindLabel} ${index + 1} up`}
          disabled={index === 0}
          onClick={() => {
            onMove(-1);
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowUp />
        </Button>
        <Button
          aria-label={`Move ${kindLabel} ${index + 1} down`}
          disabled={index === stepCount - 1}
          onClick={() => {
            onMove(1);
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ArrowDown />
        </Button>
        <Button
          aria-label={`Delete ${kindLabel} ${index + 1}`}
          onClick={onRemove}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      </div>
      {expanded ? (
        <CardContent className="pt-3">
          {problem !== undefined && <p className="mb-3 text-xs text-destructive">{problem}</p>}
          {hasErrors && (
            <ul className="mb-3 flex flex-col gap-1 text-xs text-destructive" role="alert">
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          {note !== undefined && <StepNote diagnostics={note} />}
          {children}
        </CardContent>
      ) : (
        <div className="pb-3" />
      )}
    </Card>
  );
}

/** The part of a step's validation errors the card lists (expression / SQL errors show in their own form). */
function cardMessages(errors: ValidationError[], path: string, step: Step): string[] {
  const own = errorsForStep(errors, path).filter(
    (error) =>
      !(step.kind === "calculate" && error.path === `${path}.expr`) &&
      !(step.kind === "sql" && error.path === `${path}.query`),
  );
  return [
    ...new Set(
      own.map((error) => {
        const label = errorLabel(error.path, path);
        return label === "" ? error.message : `${label}: ${error.message}`;
      }),
    ),
  ];
}

function SubPipeline({
  ctx,
  index,
  onChange,
  path,
  step,
}: {
  ctx: StepEditorContext;
  index: number;
  onChange: (step: JoinStep) => void;
  path: string;
  step: JoinStep;
}) {
  const [expanded, setExpanded] = useState<number | undefined>(undefined);
  const rightTitle = titleOf(ctx.infos, step.right.input);
  const rightInfo = ctx.infos.find((info) => info.alias === step.right.input);
  const rightStart = rightInfo === undefined ? undefined : rightInfo.fields;
  if (step.right.steps === undefined) {
    return (
      <div className="flex flex-col gap-1">
        <Button
          className="w-fit"
          disabled={step.right.input === ""}
          onClick={() => {
            onChange({ ...step, right: { ...step.right, steps: [] } });
          }}
          size="sm"
          title={step.right.input === "" ? "Pick the dataset to join with first." : undefined}
          type="button"
          variant="ghost"
        >
          <Plus className="h-3.5 w-3.5" />
          Add steps to this input
        </Button>
        <p className="text-xs text-muted-foreground">
          Filter, summarize or calculate on the joined dataset before it is matched (for example,
          count agencies per deployment first).
        </p>
      </div>
    );
  }
  return (
    <fieldset
      aria-label={`Steps on ${rightTitle} before joining (join ${index + 1})`}
      className="ml-2 flex min-w-0 flex-col gap-2 border-0 border-l-2 border-primary/30 p-0 pl-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Steps on <span className="text-primary">{rightTitle}</span> before joining
        </p>
        <Button
          onClick={() => {
            const { steps: _dropped, ...right } = step.right;
            onChange({ ...step, right });
          }}
          size="xs"
          type="button"
          variant="ghost"
        >
          Remove these steps
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Counts and previews here describe this input only. The join above is previewed in the panel
        on the right.
      </p>
      <StepList
        addLabel="Add step to this input"
        ctx={ctx}
        expanded={expanded}
        nested
        onChange={(steps) => {
          onChange({ ...step, right: { ...step.right, steps } });
        }}
        onExpand={setExpanded}
        pathPrefix={`${path}.right.steps`}
        startFields={rightStart}
        steps={step.right.steps}
      />
    </fieldset>
  );
}

/** Edits one step with its kind's form. Joins can nest a sub-pipeline, which renders this same form recursively. */
function StepForm({
  ctx,
  diagnostics,
  fields,
  index,
  onChange,
  path,
  step,
}: {
  ctx: StepEditorContext;
  diagnostics: StepDiagnostics | undefined;
  /** The fields of the rows reaching this step (undefined = shape unknown). */
  fields: string[] | undefined;
  index: number;
  onChange: (step: Step) => void;
  path: string;
  step: Step;
}) {
  switch (step.kind) {
    case "filter":
      return <FilterForm fields={fields ?? []} onChange={onChange} step={step} />;
    case "groupBy":
      return <GroupByForm fields={fields ?? []} onChange={onChange} step={step} />;
    case "calculate":
      return <CalculateForm fields={fields} onChange={onChange} step={step} />;
    case "sql":
      return (
        <SqlForm aliases={ctx.infos.map((info) => info.alias)} onChange={onChange} step={step} />
      );
    case "join":
      return (
        <JoinForm
          datasets={ctx.datasets}
          infos={ctx.infos}
          leftFields={fields ?? []}
          onChange={onChange}
          onPickRight={(datasetId) => {
            const alias = ctx.ensureInput(datasetId);
            const next = ctx.datasets.find((dataset) => dataset.id === datasetId);
            onChange(
              repointRight(step, alias, {
                old: titleOf(ctx.infos, step.right.input),
                next: next === undefined ? "" : next.title,
              }),
            );
          }}
          step={step}
          subSteps={
            <SubPipeline ctx={ctx} index={index} onChange={onChange} path={path} step={step} />
          }
          undeclaredCategories={undeclaredOf(diagnostics)}
        />
      );
    default:
      return (
        <p className="text-sm text-muted-foreground">
          This step type has no form yet. It still runs as saved.
        </p>
      );
  }
}

/**
 * A linear, editable list of steps. The top level and every join's
 * sub-pipeline use it, so a nested list has exactly the forms, problems and
 * add-step menu of the main one. Diagnostics and validation errors are found
 * by the step's `path` (`steps[0].right.steps[1]`).
 */
export function StepList({
  addLabel,
  ctx,
  expanded,
  nested,
  onChange,
  onExpand,
  pathPrefix,
  startFields,
  steps,
}: {
  addLabel?: string;
  ctx: StepEditorContext;
  expanded: number | undefined;
  nested: boolean;
  onChange: (steps: Step[]) => void;
  onExpand: (index: number | undefined) => void;
  /** `steps` at the top level, `steps[0].right.steps` for a sub-pipeline. */
  pathPrefix: string;
  /** The fields of the rows that enter the first step. */
  startFields: string[] | undefined;
  steps: Step[];
}) {
  const setStep = (index: number, step: Step): void => {
    onChange(steps.map((s, i) => (i === index ? step : s)));
  };
  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) {
      return;
    }
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    if (moved !== undefined) {
      next.splice(target, 0, moved);
    }
    onChange(next);
    onExpand(target);
  };
  return (
    <div className="flex flex-col gap-3">
      {steps.map((step, index) => {
        const path = `${pathPrefix}[${index}]`;
        const diagnostics = nested
          ? stepDiagnosticsOf(ctx.diagnostics, index, path)
          : stepDiagnosticsOf(ctx.diagnostics, index);
        return (
          <StepCard
            expanded={expanded === index}
            index={index}
            infos={ctx.infos}
            key={`${index}-${step.kind}`}
            kindLabel={nested ? "sub-step" : "step"}
            messages={cardMessages(ctx.errors, path, step)}
            nested={nested}
            note={nested ? diagnostics : undefined}
            onMove={(delta) => {
              move(index, delta);
            }}
            onRemove={() => {
              onChange(steps.filter((_, i) => i !== index));
              onExpand(undefined);
            }}
            onSelect={() => {
              onExpand(index);
            }}
            problem={stepProblem(step)}
            step={step}
            stepCount={steps.length}
          >
            <StepForm
              ctx={ctx}
              diagnostics={diagnostics}
              fields={fieldsThrough(startFields, steps.slice(0, index), ctx.infos)}
              index={index}
              onChange={(next) => {
                setStep(index, next);
              }}
              path={path}
              step={step}
            />
          </StepCard>
        );
      })}
      <AddStepMenu
        disabled={startFields === undefined && ctx.infos.length === 0}
        label={addLabel}
        onAdd={(kind) => {
          const fields = fieldsThrough(startFields, steps, ctx.infos) ?? [];
          onChange([...steps, newStepOf(kind, fields[0] ?? "")]);
          onExpand(steps.length);
        }}
      />
    </div>
  );
}
