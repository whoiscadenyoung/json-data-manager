import { analyzeSqlStep, pruneInputs, slugifyViewName } from "@caden/data-core/views";
import type {
  CompileInputMeta,
  Condition,
  ConditionLeaf,
  ConditionOp,
  JoinStep,
  KeyMatching,
  Measure,
  MultiMatch,
  Step,
  ValidationError,
  ViewDefinition,
} from "@caden/data-core/views";

/**
 * Pure helpers behind the view editor (#301): building and editing the
 * serializable step list, tracking which fields exist after each step (so
 * pickers offer real columns), and the "create view from relation" pre-fill.
 * No React, no I/O.
 */

/** A dataset or view an input may read, as the pickers list it. */
export interface PickerDataset {
  id: string;
  title: string;
  kind?: "source" | "view";
}

/** Picker options for datasets and views, grouped under "Datasets" and "Views" (a view is a valid input anywhere a dataset is). */
export function inputPickerOptions(
  datasets: readonly PickerDataset[],
): { value: string; label: string; group: string }[] {
  return datasets.map((dataset) => ({
    value: dataset.id,
    label: dataset.title,
    group: dataset.kind === "view" ? "Views" : "Datasets",
  }));
}

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

export const MEASURE_FNS = [
  "count",
  "countDistinct",
  "sum",
  "avg",
  "min",
  "max",
  "topBy",
  "text",
] as const;
export type EditableMeasureFn = (typeof MEASURE_FNS)[number];

export const MEASURE_LABELS: Record<EditableMeasureFn, string> = {
  count: "Count",
  countDistinct: "Count distinct",
  sum: "Sum",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  topBy: "Value from the top row",
  text: "Join as text",
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

export function newCalculateStep(): Step {
  return { kind: "calculate", field: "", expr: "" };
}

/** A SQL step starts as a valid pass-through so the preview works while it is edited. */
export function newSqlStep(): Step {
  return { kind: "sql", query: "select * from prev" };
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

/** The measure after its function changed: only the settings the new function uses are kept. */
export function measureWithFn(measure: Measure, fn: EditableMeasureFn): Measure {
  const { by: _by, direction: _direction, separator: _separator, field, ...rest } = measure;
  switch (fn) {
    case "count":
      return { ...rest, fn };
    case "topBy":
      return { ...rest, fn, ...(field === undefined ? {} : { field }), direction: "max" };
    case "text":
      return { ...rest, fn, ...(field === undefined ? {} : { field }), separator: ", " };
    default:
      return { ...rest, fn, ...(field === undefined ? {} : { field }) };
  }
}

/** The measure a summarize policy starts with. */
export function defaultMeasure(name: string): Measure {
  return { as: name, fn: "count" };
}

function multiMatchProblem(multiMatch: MultiMatch): string | undefined {
  switch (multiMatch.mode) {
    case "summarize":
      return multiMatch.measures.length === 0 ? "Add at least one measure." : undefined;
    case "spread":
      if (multiMatch.by === "" || multiMatch.value === "") {
        return "Pick the category field and the value field to spread.";
      }
      return multiMatch.columns.length === 0 ||
        multiMatch.columns.some((column) => column.as.trim() === "")
        ? "Declare at least one column, each with a name."
        : undefined;
    case "text":
      return multiMatch.field === "" ? "Pick the field to join as text." : undefined;
    default:
      return undefined;
  }
}

function measureProblem(measure: Measure): string | undefined {
  if (measure.as.trim() === "") {
    return "Every measure needs an output name.";
  }
  if (measure.fn !== "count" && (measure.field ?? "") === "") {
    return `Pick the field for "${measure.as}".`;
  }
  return measure.fn === "topBy" && (measure.by ?? "") === ""
    ? `Pick the field that ranks the rows for "${measure.as}".`
    : undefined;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined;
}

function joinProblem(step: JoinStep): string | undefined {
  if (step.right.input === "") {
    return "Pick the dataset to join with.";
  }
  if (step.on.length === 0 || step.on.some((pair) => pair.left === "" || pair.right === "")) {
    return "Pick the key fields on both sides.";
  }
  const { multiMatch } = step;
  const measures = multiMatch.mode === "summarize" ? multiMatch.measures : [];
  const measure = measures.map((m) => measureProblem(m)).find(isSet);
  return (
    multiMatchProblem(multiMatch) ??
    measure ??
    (step.right.steps ?? []).map((sub) => stepProblem(sub)).find(isSet)
  );
}

/** Whether a step is complete enough to compile (the editor shows the rest as "needs ..."). */
export function stepProblem(step: Step): string | undefined {
  switch (step.kind) {
    case "join":
      return joinProblem(step);
    case "filter": {
      const leaves = filterLeaves(step.where);
      return leaves === undefined || (leaves.length > 0 && leaves.every((l) => l.field !== ""))
        ? undefined
        : "Pick a field to filter on.";
    }
    case "groupBy":
      if (step.by.length === 0 || step.by.some((field) => field === "")) {
        return "Pick at least one field to group by.";
      }
      return step.measures.map((measure) => measureProblem(measure)).find(isSet);
    case "calculate":
      if (step.field.trim() === "") {
        return "Name the new field.";
      }
      return step.expr.trim() === "" ? "Write the expression to calculate." : undefined;
    case "sql":
      return step.query.trim() === "" ? "Write the SQL query." : undefined;
    default:
      return undefined;
  }
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

/**
 * The join after its right side was re-picked (`alias` is the declared input
 * for the new dataset): the key fields of the old side and the sub-pipeline
 * built on it no longer apply, and a default prefix follows the new title.
 */
export function repointRight(
  step: JoinStep,
  alias: string,
  titles: { old: string; next: string },
): JoinStep {
  if (step.right.input === alias) {
    return step;
  }
  const oldDefault = slugifyViewName(titles.old);
  const usesDefault = step.prefix === undefined || step.prefix === "" || step.prefix === oldDefault;
  return {
    ...step,
    right: { input: alias },
    on: step.on.map((pair) => ({ ...pair, right: "" })),
    prefix: usesDefault ? slugifyViewName(titles.next) : step.prefix,
  };
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
 * input), or undefined once the shape is unknown (after an sql step that
 * returns a bare `d`). Mirrors the validator's field scope in
 * `@caden/data-core/views`.
 */
export function fieldsAfter(
  definition: ViewDefinition,
  infos: readonly InputInfo[],
  upto: number,
): string[] | undefined {
  return fieldsThrough(
    inputFields(infos, definition.base),
    definition.steps.slice(0, upto + 1),
    infos,
  );
}

/** The fields after running `steps` over rows that start with `start` (a sub-pipeline's right input, or the base). */
export function fieldsThrough(
  start: string[] | undefined,
  steps: readonly Step[],
  infos: readonly InputInfo[],
): string[] | undefined {
  let known = start;
  for (const step of steps) {
    if (known === undefined) {
      return undefined;
    }
    known = fieldsAfterStep(known, step, infos);
  }
  return known;
}

/** The fields of a join's right side: the input, then its sub-pipeline when it has one. */
export function rightFieldsOf(step: JoinStep, infos: readonly InputInfo[]): string[] | undefined {
  return fieldsThrough(inputFields(infos, step.right.input), step.right.steps ?? [], infos);
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
      return step.field === "" || known.includes(step.field) ? known : [...known, step.field];
    case "join":
      return fieldsAfterJoin(known, step, infos);
    case "sql":
      return fieldsAfterSql(step.query, infos);
    default:
      return undefined;
  }
}

function fieldsAfterSql(query: string, infos: readonly InputInfo[]): string[] | undefined {
  const result = analyzeSqlStep(
    query,
    infos.map((info) => info.alias),
  );
  if (!result.ok || result.analysis.columns.includes("d")) {
    return undefined;
  }
  return result.analysis.columns.filter((name) => name !== "row_id" && name !== "geom");
}

/** `prefix.name`, or just the name when the prefix is empty. */
export function prefixedName(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}.${name}`;
}

function joinAdded(
  step: JoinStep,
  infos: readonly InputInfo[],
  right: string[] | undefined,
): string[] | undefined {
  const { multiMatch } = step;
  const info = infos.find((entry) => entry.alias === step.right.input);
  const title = info === undefined ? "" : info.title;
  const prefix = step.prefix ?? slugifyViewName(title);
  switch (multiMatch.mode) {
    case "summarize":
      return multiMatch.measures.map((measure) => measure.as);
    case "spread":
      return multiMatch.columns.map((column) => column.as);
    case "text":
      return [prefixedName(prefix, multiMatch.field)];
    case "list":
      return [prefix === "" ? slugifyViewName(title) : prefix];
    default: {
      const names = step.fields ?? right;
      return names === undefined ? undefined : names.map((n) => prefixedName(prefix, n));
    }
  }
}

function fieldsAfterJoin(
  known: string[],
  step: JoinStep,
  infos: readonly InputInfo[],
): string[] | undefined {
  const added = joinAdded(step, infos, rightFieldsOf(step, infos));
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
        step.multiMatch.mode === "first" || step.multiMatch.mode === "last"
          ? `${step.multiMatch.mode} match`
          : step.multiMatch.mode;
      const steps = step.right.steps === undefined ? "" : ", with steps";
      return `${title} (${step.type}, ${policy}${steps})`;
    }
    case "groupBy":
      return `by ${step.by.join(", ") || "…"}`;
    case "select":
      return `${step.fields.length} fields`;
    case "calculate":
      return step.field === "" ? "…" : step.field;
    default:
      return "Custom SQL";
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
    };
    // A view that has never run declares no fields yet: leave them unknown rather than "none".
    if (info.fields.length > 0) {
      meta.fields = info.fields.map((name) => ({ name }));
    }
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

/** Drops inputs no step reads (never the base), so Save does not declare dead inputs. Sub-pipelines and SQL `in_<alias>` reads count. */
export function prunedInputs(definition: ViewDefinition): ViewDefinition {
  return pruneInputs(definition);
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

/** The validation errors at or under `path`, leaving out those that belong to a nested sub-pipeline's own steps. */
export function errorsForStep(errors: readonly ValidationError[], path: string): ValidationError[] {
  const inside = (error: ValidationError): boolean =>
    error.path === path || error.path.startsWith(`${path}.`) || error.path.startsWith(`${path}[`);
  return errors.filter((error) => inside(error) && !error.path.startsWith(`${path}.right.steps[`));
}

const PATH_LABELS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^multiMatch\.measures\[(\d+)\]\.(\w+)$/, (m) => `Measure ${Number(m[1]) + 1} ${m[2]}`],
  [/^measures\[(\d+)\]\.(\w+)$/, (m) => `Measure ${Number(m[1]) + 1} ${m[2]}`],
  [/^multiMatch\.columns\[(\d+)\]$/, (m) => `Spread column ${Number(m[1]) + 1}`],
  [/^multiMatch\.(by|value|field)$/, (m) => `Spread ${m[1]} field`],
  [/^on\[(\d+)\]\.(left|right)$/, (m) => `Key pair ${Number(m[1]) + 1} (${m[2]})`],
  [/^on\[(\d+)\]$/, (m) => `Key pair ${Number(m[1]) + 1}`],
  [/^by\[(\d+)\]$/, (m) => `Group field ${Number(m[1]) + 1}`],
  [/^where.*$/, () => "Condition"],
];

/** Where in the step a validation error points, in the form's own words (the part of `path` after the step). */
export function errorLabel(path: string, stepPath: string): string {
  const tail = path === stepPath ? "" : path.slice(stepPath.length).replace(/^\./, "");
  for (const [pattern, label] of PATH_LABELS) {
    const match = pattern.exec(tail);
    if (match !== null) {
      return label(match);
    }
  }
  return tail;
}

/** A category value as a column name the spread proposes: letters and digits, camel-cased. */
export function columnNameFor(category: string): string {
  const words = category.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  const joined = words
    .map((word, i) => (i === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`))
    .join("");
  return joined === "" ? "value" : joined;
}

/** Columns for categories not yet declared; names stay unique among `taken`. */
export function proposeSpreadColumns(
  categories: readonly string[],
  existing: readonly { category: string; as: string }[],
  taken: readonly string[],
): { category: string; as: string }[] {
  const used = new Set([...existing.map((column) => column.as), ...taken]);
  const declared = new Set(existing.map((column) => column.category));
  const added: { category: string; as: string }[] = [];
  for (const category of categories) {
    if (declared.has(category) || category === "") {
      continue;
    }
    declared.add(category);
    const base = columnNameFor(category);
    let name = base;
    for (let n = 2; used.has(name); n += 1) {
      name = `${base}_${n}`;
    }
    used.add(name);
    added.push({ category, as: name });
  }
  return added;
}
