import type { ViewDefinition } from "@caden/data-core/views";
import { Badge } from "@caden/ui/components/badge";
import { cn } from "@caden/ui/lib/utils";
import { Database, Flag, type LucideIcon } from "lucide-react";

import { stepKindVisual } from "@/features/view-graphs";

import { describeCanvasStep, type CanvasContext } from "../lib/canvas-nodes";
import { inputOf, nestedOf, OUTPUT, type Selection } from "../lib/selection";
import type { InputInfo } from "../lib/view-model";

/**
 * The editor's left sidebar: the whole view as an outline, in run order. The
 * starting dataset, every step (a join's other input and its sub-steps
 * indented under it) and the output, each one a button that selects it
 * everywhere (canvas, settings, preview). Steps carry their kind's icon and
 * tint, their number and the same summary and badge as the canvas node.
 */

const BADGE_CLASS = {
  error: "border-destructive text-destructive",
  neutral: "border-dashed",
  warning: "border-amber-500 text-amber-700 dark:text-amber-300",
} as const;

function Row({
  badge,
  detail,
  icon: Icon,
  indent = false,
  label,
  onSelect,
  selected,
  tone,
}: {
  badge?: { label: string; tone: keyof typeof BADGE_CLASS };
  detail?: string;
  icon: LucideIcon;
  indent?: boolean;
  label: string;
  onSelect: () => void;
  selected: boolean;
  tone: string;
}) {
  return (
    <li className={indent ? "ml-4 border-l pl-2" : undefined}>
      <button
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
          selected ? "bg-muted ring-1 ring-primary/40" : "",
        )}
        onClick={onSelect}
        type="button"
      >
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", tone)}>
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{label}</span>
          {detail === undefined || detail === "" ? null : (
            <span className="truncate text-xs text-muted-foreground">{detail}</span>
          )}
        </span>
        {badge === undefined ? null : (
          <Badge className={cn("shrink-0", BADGE_CLASS[badge.tone])} variant="outline">
            {badge.label}
          </Badge>
        )}
      </button>
    </li>
  );
}

const INPUT_TONE = "bg-muted text-muted-foreground";

function titleOf(infos: readonly InputInfo[], alias: string): string {
  const found = infos.find((info) => info.alias === alias);
  return found === undefined ? alias : found.title;
}

export function StepOutline({
  context,
  onSelect,
  outputDetail,
  selected,
}: {
  context: CanvasContext;
  onSelect: (selection: Selection) => void;
  outputDetail: string | undefined;
  selected: Selection;
}) {
  const { definition, infos } = context;
  const selectedInput = inputOf(selected);
  const nested = nestedOf(selected);
  return (
    <ol className="flex flex-col gap-0.5">
      <Row
        detail="Starts from"
        icon={Database}
        label={titleOf(infos, definition.base)}
        onSelect={() => {
          onSelect({ input: definition.base });
        }}
        selected={selectedInput === definition.base}
        tone={INPUT_TONE}
      />
      {definition.steps.map((step, index) => (
        <OutlineStep
          context={context}
          index={index}
          // Steps have no identity of their own: position + kind is what a row stands for.
          // oxlint-disable-next-line react/no-array-index-key
          key={`${index}-${step.kind}`}
          nestedStep={nested !== undefined && nested.join === index ? nested.step : undefined}
          onSelect={onSelect}
          selected={selected === index}
          selectedInput={selectedInput}
          step={step}
        />
      ))}
      <Row
        detail={outputDetail}
        icon={Flag}
        label="Output"
        onSelect={() => {
          onSelect(OUTPUT);
        }}
        selected={selected === OUTPUT}
        tone="bg-primary text-primary-foreground"
      />
    </ol>
  );
}

function OutlineStep({
  context,
  index,
  nestedStep,
  onSelect,
  selected,
  selectedInput,
  step,
}: {
  context: CanvasContext;
  index: number;
  /** The selected sub-step of this join, if any. */
  nestedStep: number | undefined;
  onSelect: (selection: Selection) => void;
  selected: boolean;
  selectedInput: string | undefined;
  step: ViewDefinition["steps"][number];
}) {
  const described = describeCanvasStep(context, { index }) ?? {};
  const visual = stepKindVisual(step.kind);
  const right = step.kind === "join" && step.right.input !== "" ? step.right : undefined;
  return (
    <>
      <Row
        badge={described.badge}
        detail={described.detail}
        icon={visual.icon}
        label={described.label ?? step.kind}
        onSelect={() => {
          onSelect(index);
        }}
        selected={selected}
        tone={visual.tone}
      />
      {right === undefined ? null : (
        <Row
          detail="Joined in"
          icon={Database}
          indent
          label={titleOf(context.infos, right.input)}
          onSelect={() => {
            onSelect({ input: right.input });
          }}
          selected={selectedInput === right.input}
          tone={INPUT_TONE}
        />
      )}
      {(right === undefined ? [] : (right.steps ?? [])).map((sub, subIndex) => {
        const subDescribed = describeCanvasStep(context, { index, sub: subIndex }) ?? {};
        const subVisual = stepKindVisual(sub.kind);
        return (
          <Row
            badge={subDescribed.badge}
            detail={subDescribed.detail}
            icon={subVisual.icon}
            indent
            // oxlint-disable-next-line react/no-array-index-key
            key={`${subIndex}-${sub.kind}`}
            label={subDescribed.label ?? sub.kind}
            onSelect={() => {
              onSelect({ join: index, step: subIndex });
            }}
            selected={nestedStep === subIndex}
            tone={subVisual.tone}
          />
        );
      })}
    </>
  );
}
