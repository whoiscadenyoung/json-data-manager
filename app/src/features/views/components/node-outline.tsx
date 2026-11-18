import { Badge } from "@caden/ui/components/badge";
import { cn } from "@caden/ui/lib/utils";
import { Flag, type LucideIcon } from "lucide-react";

import { stepKindVisual } from "@/features/view-graphs";

import { describeCanvasNode, type CanvasContext } from "../lib/canvas-nodes";
import { nodeOf, OUTPUT, type Selection } from "../lib/selection";
import { outlineOrder } from "../lib/view-model";

/**
 * The editor's left sidebar: the whole view as an outline, in dependency
 * order (what feeds the result comes first; unused nodes last). Every node is
 * a button that selects it everywhere (canvas, settings, preview), with its
 * kind's icon and tint, its name, a one-line summary and the same badge as the
 * canvas node. The output is the last row.
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
  label,
  onSelect,
  selected,
  tone,
}: {
  badge?: { label: string; tone: keyof typeof BADGE_CLASS };
  detail?: string;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  selected: boolean;
  tone: string;
}) {
  return (
    <li>
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

export function NodeOutline({
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
  const { definition } = context;
  const selectedNode = nodeOf(selected);
  return (
    <ol className="flex flex-col gap-0.5">
      {outlineOrder(definition).map((id) => {
        const described = describeCanvasNode(context, id) ?? {};
        const visual = stepKindVisual(definition.nodes[id].kind);
        return (
          <Row
            badge={described.badge}
            detail={described.detail}
            icon={visual.icon}
            key={id}
            label={described.label ?? id}
            onSelect={() => {
              onSelect({ node: id });
            }}
            selected={selectedNode === id}
            tone={visual.tone}
          />
        );
      })}
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
