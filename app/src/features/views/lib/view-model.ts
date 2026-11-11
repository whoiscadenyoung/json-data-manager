import { slugifyViewName } from "@caden/data-core/views";
import type {
  CompileInputMeta,
  Condition,
  ConditionLeaf,
  ConditionOp,
  JoinStep,
  KeyMatching,
  Measure,
  Step,
  ViewDefinition,
} from "@caden/data-core/views";

/**
 * Pure helpers behind the view editor (#301): building and editing the
 * serializable step list, tracking which fields exist after each step (so
 * pickers offer real columns), and the "create view from relation" pre-fill.
 * No React, no I/O.
 */

/** An input as the editor shows it: alias, the dataset's TITLE (never the uuid) and its declared fields. */
export interface InputInfo {
  alias: string;
  datasetId: string;
  title: string;
  fields: string[];
}

export const DEFAULT_MATCHING: KeyMatching = {
  trim: true,
  caseFold: false,
  collapseSpace: false,
  stripDiacritics: false,
};

export const MEASURE_FNS = ["count", "countDistinct", "sum", "avg", "min", "max"] as const;
export type EditableMeasureFn = (typeof MEASURE_FNS)[number];

export const MEASURE_LABELS: Record<EditableMeasureFn, string> = {
  count: "Count",
  countDistinct: "Count distinct",
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};

export const FILTER_OPS: { op: ConditionOp; label: string }[] = [
  { op: "eq", label: "is" },
  { op: "neq", label: "is not" },
  { op: "gt", label: "greater than" },
  { op: "gte", label: "at least" },
  { op: "lt", label: "less than" },
  { op: "lte", label: "at most" },
  { op: "contains", label: "contains" },
  { op: "in", label: "is one of" },
  { op: "isNull", label: "is empty" },
  { op: "notNull", label: "is not empty" },
];

/** A readable, unique input alias for a dataset title (aliases are letters, digits and underscores). */
export function uniqueAlias(title: string, taken: readonly string[]): string {
  const base = slugifyViewName(title) || "input";
  if (!taken.includes(base)) {
    return base;
  }
  let n = 2;
  while (taken.includes(`${base}_${n}`)) {
    n += 1;
  }
  return `${base}_${n}`;
}

export function emptyOutput(): ViewDefinition["output"] {
  return { fields: [], emptyFields: "keep" };
}

/** A blank view over one base dataset. */
export function blankDefinition(base: { datasetId: string; title: string }): ViewDefinition {
  const alias = uniqueAlias(base.title, []);
  return {
    inputs: [{ alias, ref: { kind: "dataset", id: base.datasetId } }],
    base: alias,
    steps: [],
    output: emptyOutput(),
  };
}

export function newFilterStep(field: string): Step {
  return { kind: "filter", where: { field, op: "eq", value: "" } };
}

export function newGroupByStep(field: string): Step {
  return { kind: "groupBy", by: [field], measures: [{ as: "count", fn: "count" }] };
}

/** A join step with the prefix defaulting to the slugified title of the right input. */
export function newJoinStep(args: {
  rightAlias: string;
  rightTitle: string;
  left?: string;
  right?: string;
}): JoinStep {
  return {
    kind: "join",
    right: { input: args.rightAlias },
    on: [{ left: args.left ?? "", right: args.right ?? "" }],
    matching: { ...DEFAULT_MATCHING },
    type: "left",
    multiMatch: { mode: "first" },
    prefix: slugifyViewName(args.rightTitle),
  };
}

/** The measure a summarize policy starts with. */
export function defaultMeasure(name: string): Measure {
  return { as: name, fn: "count" };
}

/** Whether a step is complete enough to compile (the editor shows the rest as "needs ..."). */
export function stepProblem(step: Step): string | undefined {
  if (step.kind === "join") {
    if (step.right.input === "") {
      return "Pick the dataset to join with.";
    }
    if (step.on.length === 0 || step.on.some((pair) => pair.left === "" || pair.right === "")) {
      return "Pick the key fields on both sides.";
    }
    if (step.multiMatch.mode === "summarize" && step.multiMatch.measures.length === 0) {
      return "Add at least one measure.";
    }
    return undefined;
  }
  if (step.kind === "filter") {
    const leaves = filterLeaves(step.where);
    if (leaves === undefined || leaves.length === 0 || leaves.some((leaf) => leaf.field === "")) {
      return leaves === undefined ? undefined : "Pick a field to filter on.";
    }
    return undefined;
  }
  if (step.kind === "groupBy") {
    if (step.by.length === 0) {
      return "Pick at least one field to group by.";
    }
    return undefined;
  }
  return undefined;
}

/** The leaves of a simple filter (one condition, or an AND of conditions), or undefined for a nested tree this form cannot edit. */
export function filterLeaves(where: Condition): ConditionLeaf[] | undefined {
  if ("field" in where) {
    return [where];
  }
  if ("and" in where && where.and.every((child) => "field" in child)) {
    return where.and.filter((child): child is ConditionLeaf => "field" in child);
  }
  return undefined;
}

export function leavesToWhere(leaves: ConditionLeaf[]): Condition {
  const [only] = leaves;
  return leaves.length === 1 && only !== undefined ? only : { and: leaves };
}

/** A filter value as typed: numbers stay numbers, "in" splits on commas, empty-checks carry none. */
export function filterValue(op: ConditionOp, raw: string): unknown {
  if (op === "isNull" || op === "notNull") {
    return undefined;
  }
  if (op === "in") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(numberOrText);
  }
  if (op === "contains") {
    return raw;
  }
  return numberOrText(raw);
}

function numberOrText(raw: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

/** A filter value back as the text field shows it. */
export function filterValueText(leaf: ConditionLeaf): string {
  const { value } = leaf;
  if (Array.isArray(value)) {
    return value.map((item) => scalarText(item)).join(", ");
  }
  return scalarText(value);
}

/** Adds one manual key-map entry (from -> to) to a join, replacing an earlier entry for the same `from`. */
export function withManualMapEntry(step: JoinStep, from: string, to: string): JoinStep {
  const existing = (step.matching.manualMap ?? []).filter((entry) => entry.from !== from);
  return { ...step, matching: { ...step.matching, manualMap: [...existing, { from, to }] } };
}

export function withoutManualMapEntry(step: JoinStep, from: string): JoinStep {
  const remaining = (step.matching.manualMap ?? []).filter((entry) => entry.from !== from);
  const { manualMap: _dropped, ...rest } = step.matching;
  return {
    ...step,
    matching: remaining.length === 0 ? rest : { ...rest, manualMap: remaining },
  };
}

function inputFields(infos: readonly InputInfo[], alias: string): string[] | undefined {
  const info = infos.find((entry) => entry.alias === alias);
  return info === undefined ? undefined : info.fields;
}

/**
 * The field names present after `steps[0..upto]` (use -1 for the bare base
 * input), or undefined once the shape is unknown (after an sql step).
 * Mirrors the validator's field scope in `@caden/data-core/views`.
 */
export function fieldsAfter(
  definition: ViewDefinition,
  infos: readonly InputInfo[],
  upto: number,
): string[] | undefined {
  let known: string[] | undefined = inputFields(infos, definition.base);
  for (const step of definition.steps.slice(0, upto + 1)) {
    if (known === undefined) {
      return undefined;
    }
    known = fieldsAfterStep(known, step, infos);
  }
  return known;
}

function fieldsAfterStep(
  known: string[],
  step: Step,
  infos: readonly InputInfo[],
): string[] | undefined {
  switch (step.kind) {
    case "filter":
      return known;
    case "select":
      return step.fields.map((field) => field.as);
    case "groupBy":
      return [...step.by, ...step.measures.map((measure) => measure.as)];
    case "calculate":
      return known.includes(step.field) ? known : [...known, step.field];
    case "join":
      return fieldsAfterJoin(known, step, infos);
    default:
      return undefined;
  }
}

function fieldsAfterJoin(
  known: string[],
  step: JoinStep,
  infos: readonly InputInfo[],
): string[] | undefined {
  const { multiMatch } = step;
  let added: string[] | undefined;
  if (multiMatch.mode === "summarize") {
    added = multiMatch.measures.map((measure) => measure.as);
  } else if (multiMatch.mode === "spread") {
    added = multiMatch.columns.map((column) => column.as);
  } else if (multiMatch.mode === "first" || multiMatch.mode === "last") {
    const info = infos.find((entry) => entry.alias === step.right.input);
    const names = step.fields ?? (info === undefined ? undefined : info.fields);
    const prefix = step.prefix ?? slugifyViewName(info === undefined ? "" : info.title);
    added =
      names === undefined ? undefined : names.map((n) => (prefix === "" ? n : `${prefix}.${n}`));
  }
  if (added === undefined) {
    return undefined;
  }
  return [...known, ...added.filter((name) => !known.includes(name))];
}

/** A one-line description of a step for the list. */
export function stepSummary(step: Step, infos: readonly InputInfo[]): string {
  switch (step.kind) {
    case "filter": {
      const leaves = filterLeaves(step.where);
      return leaves === undefined
        ? "Custom filter"
        : leaves.length === 0
          ? "Filter"
          : leaves.map((leaf) => `${leaf.field || "…"} ${opLabel(leaf.op)}`).join(" and ");
    }
    case "join": {
      const info = infos.find((entry) => entry.alias === step.right.input);
      const title = info === undefined ? step.right.input : info.title;
      const policy =
        step.multiMatch.mode === "summarize"
          ? "summarize"
          : step.multiMatch.mode === "first" || step.multiMatch.mode === "last"
            ? `${step.multiMatch.mode} match`
            : step.multiMatch.mode;
      return `${title} (${step.type}, ${policy})`;
    }
    case "groupBy":
      return `by ${step.by.join(", ") || "…"}`;
    case "select":
      return `${step.fields.length} fields`;
    case "calculate":
      return step.field;
    default:
      return "SQL";
  }
}

export const STEP_TITLES: Record<Step["kind"], string> = {
  filter: "Filter rows",
  join: "Join",
  groupBy: "Group by",
  select: "Select fields",
  calculate: "Calculate",
  sql: "SQL",
};

function opLabel(op: ConditionOp): string {
  const found = FILTER_OPS.find((entry) => entry.op === op);
  return found === undefined ? op : found.label;
}

/** Input metadata in the compiler's shape, for client-side validation. */
export function toCompileMeta(
  infos: readonly InputInfo[],
  pinned: Record<string, string | undefined> = {},
): CompileInputMeta[] {
  return infos.map((info) => {
    const meta: CompileInputMeta = {
      alias: info.alias,
      datasetId: info.datasetId,
      title: info.title,
      fields: info.fields.map((name) => ({ name })),
    };
    const pin = pinned[info.alias];
    if (pin !== undefined) {
      meta.pinnedVersion = pin;
    }
    return meta;
  });
}

/** The inputs `save_view` / the preview take, from the definition itself. */
export function inputRefsOf(
  definition: ViewDefinition,
): { alias: string; datasetId: string; pinnedVersion?: string }[] {
  return definition.inputs.map((input) =>
    input.ref.version === undefined
      ? { alias: input.alias, datasetId: input.ref.id }
      : { alias: input.alias, datasetId: input.ref.id, pinnedVersion: input.ref.version },
  );
}

/**
 * Whether SQL text mentions the table `name` as a whole identifier (bare or
 * double-quoted). Textual and conservative: a mention inside a string literal
 * counts too, which only ever keeps an input declared.
 */
export function sqlReadsTable(sql: string, name: string): boolean {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`(?<![A-Za-z0-9_$])"?${escaped}"?(?![A-Za-z0-9_$])`, "i").test(sql);
}

/** Drops inputs no step reads (never the base), so Save does not declare dead inputs. */
export function prunedInputs(definition: ViewDefinition): ViewDefinition {
  const used = new Set<string>([definition.base]);
  for (const step of definition.steps) {
    if (step.kind === "join") {
      used.add(step.right.input);
    }
    if (step.kind === "sql") {
      // A sql step reads inputs by name: `in_<alias>` (Save as view from the Scratch query).
      for (const input of definition.inputs) {
        if (sqlReadsTable(step.query, `in_${input.alias}`)) {
          used.add(input.alias);
        }
      }
    }
  }
  return { ...definition, inputs: definition.inputs.filter((input) => used.has(input.alias)) };
}

/** A Scratch-query table: SQL name `in_<alias>` plus the dataset behind it. */
export interface ScratchTableInfo {
  alias: string;
  datasetId: string;
  fields: string[];
  kind: "source" | "view";
  name: string;
  title: string;
}

/** The scratch tables the query reads, in table-list order. */
export function referencedScratchTables(
  sql: string,
  tables: readonly ScratchTableInfo[],
): ScratchTableInfo[] {
  return tables.filter((table) => sqlReadsTable(sql, table.name));
}

/**
 * "Save as view" (#306): one `sql` step holding the query UNCHANGED (minus a
 * trailing `;`). The scratch names ARE the compiler's input CTE names
 * (`in_<alias>`), so each table the query reads becomes the input of that
 * alias. `baseAlias` is the input whose rows and geometry the view keeps.
 */
export function definitionFromScratch(
  sql: string,
  tables: readonly ScratchTableInfo[],
  baseAlias: string,
): ViewDefinition {
  const referenced = referencedScratchTables(sql, tables);
  if (referenced.length === 0) {
    throw new Error("The query doesn't read any table, so there is nothing to build a view on.");
  }
  if (!referenced.some((table) => table.alias === baseAlias)) {
    throw new Error("Pick one of the tables the query reads as the base.");
  }
  return {
    inputs: referenced.map((table) => ({
      alias: table.alias,
      ref: { kind: "dataset", id: table.datasetId },
    })),
    base: baseAlias,
    steps: [{ kind: "sql", query: sql.replace(/[\s;]+$/, "").trim() }],
    output: emptyOutput(),
  };
}

/** A key relation, as the relations section holds it. */
export interface RelationSeed {
  fromDataset: string;
  toDataset: string;
  fromKey: string;
  toKey: string;
  cardinality: "1-1" | "1-N" | "N-M";
  fromTitle: string;
  toTitle: string;
}

/**
 * "Create view from relation" (replaces "Join into a table"): the base is the
 * relation's FROM side, with one Join step to the TO side on the relation's
 * keys. A 1-1 relation takes the first match; anything else summarizes with a
 * count so no row is silently dropped or multiplied.
 */
export function definitionFromRelation(seed: RelationSeed): {
  title: string;
  definition: ViewDefinition;
} {
  const baseAlias = uniqueAlias(seed.fromTitle, []);
  const rightAlias = uniqueAlias(seed.toTitle, [baseAlias]);
  const prefix = slugifyViewName(seed.toTitle);
  const step: JoinStep = {
    kind: "join",
    right: { input: rightAlias },
    on: [{ left: seed.fromKey, right: seed.toKey }],
    matching: { ...DEFAULT_MATCHING },
    type: "left",
    multiMatch:
      seed.cardinality === "1-1"
        ? { mode: "first" }
        : { mode: "summarize", measures: [{ as: `${prefix}_count`, fn: "count" }] },
    ...(seed.cardinality === "1-1" ? { prefix } : {}),
  };
  return {
    title: `${seed.fromTitle} + ${seed.toTitle}`,
    definition: {
      inputs: [
        { alias: baseAlias, ref: { kind: "dataset", id: seed.fromDataset } },
        { alias: rightAlias, ref: { kind: "dataset", id: seed.toDataset } },
      ],
      base: baseAlias,
      steps: [step],
      output: emptyOutput(),
    },
  };
}

/** The first validation problem as one sentence, noting how many more there are. */
export function validationSummary(errors: readonly { message: string }[]): string {
  const [first] = errors;
  const head = first === undefined ? "The steps are not valid yet." : first.message;
  return errors.length > 1 ? `${head} (and ${errors.length - 1} more)` : head;
}
