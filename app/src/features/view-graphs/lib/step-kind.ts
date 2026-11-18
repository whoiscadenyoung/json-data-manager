import {
  Calculator,
  Code,
  Database,
  Funnel,
  Layers,
  ListChecks,
  Merge,
  Sigma,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * How a node kind looks wherever nodes are drawn (canvas nodes, the editor's
 * outline, the add-node controls): one icon and one tint per kind, so a
 * join reads as a join at a glance. Unknown kinds fall back to the neutral
 * entry. Tints differ in hue AND carry an icon, never colour alone.
 */
export interface StepKindVisual {
  icon: LucideIcon;
  /** Tailwind classes for the icon's tile: a soft fill and a readable foreground. */
  tone: string;
}

const NEUTRAL: StepKindVisual = { icon: Workflow, tone: "bg-muted text-muted-foreground" };

export const STEP_KIND_VISUALS: Record<string, StepKindVisual> = {
  stack: { icon: Layers, tone: "bg-teal-500/15 text-teal-700 dark:text-teal-300" },
  calculate: {
    icon: Calculator,
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  filter: { icon: Funnel, tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  groupBy: { icon: Sigma, tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  join: { icon: Merge, tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  columns: { icon: ListChecks, tone: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  source: { icon: Database, tone: "bg-muted text-muted-foreground" },
  sql: { icon: Code, tone: "bg-slate-500/15 text-slate-700 dark:text-slate-300" },
};

export function stepKindVisual(kind: string | undefined): StepKindVisual {
  return (kind === undefined ? undefined : STEP_KIND_VISUALS[kind]) ?? NEUTRAL;
}
