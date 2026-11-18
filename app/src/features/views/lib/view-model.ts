import { freshNodeId, nodeFields, pruneNodes, slugifyViewName } from "@caden/data-core/views";
import type {
  ColumnEdit,
  CompileInputMeta,
  Condition,
  ConditionLeaf,
  ConditionOp,
  FieldType,
  JoinNode,
  KeyMatching,
  Measure,
  MultiMatch,
  NodeKind,
  ValidationError,
  ViewDefinition,
  ViewNode,
} from "@caden/data-core/views";

/**
 * Pure helpers behind the view editor (docs/views-node-graph-design.md):
 * building and editing the node graph, tracking which fields each node
 * produces (so pickers offer real columns), and the "create view from
 * relation" pre-fill. No React, no I/O.
 */

/** A dataset or view an input may read, as the pickers list it. */
export interface PickerDataset {
  id: string;
  title: string;
  kind?: "source" | "view";
  /** The holding project's title, when known (#338): titles collide across projects ("States" twice), so the pickers suffix the project. */
  projectTitle?: string;
}

/** Picker options for datasets and views, grouped under "Datasets" and "Views" (a view is a valid input anywhere a dataset is). */
export function inputPickerOptions(
  datasets: readonly PickerDataset[],
): { value: string; label: string; group: string }[] {
  return datasets.map((dataset) => ({
    value: dataset.id,
    label:
      dataset.projectTitle === undefined
        ? dataset.title
        : `${dataset.title} · ${dataset.projectTitle}`,
    group: dataset.kind === "view" ? "Views" : "Datasets",
  }));
}

/**
 * A source node as the editor shows it: its node id (`alias`, also the
 * `view_inputs.alias` column), the dataset's TITLE (never the uuid) and its
 * declared fields.
 */
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

export function emptyOutput(): ViewDefinition["result"]["output"] {
  return { fields: [], emptyFields: "keep" };
}

/** A readable, unique node id for a label (lowercase letters, digits, underscores). */
export function uniqueNodeId(label: string, taken: readonly string[]): string {
  return freshNodeId(label, taken);
}

/** A blank view over several datasets: one source node each; `base` (default the first) is the result until a node is added. */
export function blankDefinitionOf(
  inputs: readonly { datasetId: string; title: string }[],
  base?: string,
): ViewDefinition {
  const nodes: Record<string, ViewNode> = {};
  let result = "";
  let matched = false;
  for (const input of inputs) {
    const id = uniqueNodeId(input.title, Object.keys(nodes));
    nodes[id] = { kind: "source", ref: { kind: "dataset", id: input.datasetId } };
    const isBase: boolean = !matched && base !== undefined && input.datasetId === base;
    if (result === "" || isBase) {
      result = id;
      matched = matched || isBase;
    }
  }
  return { nodes, result: { node: result, output: emptyOutput() } };
}

/** The definition with one more source node (always a new id, so a dataset can be added twice). */
export function withAddedSource(
  definition: ViewDefinition,
  dataset: { id: string; title: string },
): { definition: ViewDefinition; node: string } {
  const node = uniqueNodeId(dataset.title, Object.keys(definition.nodes));
  return {
    node,
    definition: {
      ...definition,
      nodes: {
        ...definition.nodes,
        [node]: { kind: "source", ref: { kind: "dataset", id: dataset.id } },
      },
    },
  };
}

export type AddableKind = Exclude<NodeKind, "source">;

export const NODE_TITLES: Record<NodeKind, string> = {
  source: "Dataset",
  filter: "Filter rows",
  columns: "Columns",
  calculate: "Calculate",
  groupBy: "Group by",
  join: "Join",
  stack: "Stack",
  sql: "SQL",
};

/** A new node of `kind` reading `from`, starting valid where it can (the editor shows the rest as "needs ..."). */
export function newNode(kind: AddableKind, from: string, firstField: string): ViewNode {
  switch (kind) {
    case "filter":
      return { kind, from, where: { field: firstField, op: "eq", value: "" } };
    case "columns":
      return { kind, from, edits: [] };
    case "calculate":
      return { kind, from, fields: [{ field: "", expr: "" }] };
    case "groupBy":
      return { kind, from, by: [firstField], measures: [{ as: "count", fn: "count" }] };
    case "sql":
      return { kind, from, query: "select * from prev" };
    case "stack":
      return { kind, inputs: [{ node: from }, { node: "" }] };
    default:
      return {
        kind,
        left: from,
        right: "",
        on: [{ left: "", right: "" }],
        matching: { ...DEFAULT_MATCHING },
        type: "left",
        multiMatch: { mode: "first" },
      };
  }
}

/** The node with every reference to `oldId` pointed at `newId` (sql reads and `in_<id>` text included). */
export function withInputReplaced(node: ViewNode, oldId: string, newId: string): ViewNode {
  const swap = (id: string): string => (id === oldId ? newId : id);
  switch (node.kind) {
    case "source":
      return node;
    case "join":
      return { ...node, left: swap(node.left), right: swap(node.right) };
    case "stack":
      return {
        ...node,
        inputs: node.inputs.map((input) => ({ ...input, node: swap(input.node) })),
      };
    case "sql":
      return {
        ...node,
        from: swap(node.from),
        ...(node.reads === undefined ? {} : { reads: node.reads.map(swap) }),
        query: node.query.replaceAll(new RegExp(`\\bin_${oldId}\\b`, "g"), `in_${newId}`),
      };
    default:
      return { ...node, from: swap(node.from) };
  }
}

function withNode(definition: ViewDefinition, id: string, node: ViewNode): ViewDefinition {
  return { ...definition, nodes: { ...definition.nodes, [id]: node } };
}

/**
 * A new node of `kind` reading `from`. When `from` is the result, the new
 * node becomes the result (append); otherwise it is a branch and nothing else
 * changes.
 */
export function appendNode(
  definition: ViewDefinition,
  from: string,
  kind: AddableKind,
  firstField: string,
): { definition: ViewDefinition; node: string } {
  const node = uniqueNodeId(NODE_TITLES[kind], Object.keys(definition.nodes));
  const next = withNode(definition, node, {
    ...newNode(kind, from, firstField),
    label: NODE_TITLES[kind],
  });
  return {
    node,
    definition:
      definition.result.node === from ? { ...next, result: { ...next.result, node } } : next,
  };
}

/**
 * A new node on the connection `source -> target` (`target` = "result" for
 * the connection into the output): it reads `source`, and `target` reads it
 * instead.
 */
export function insertOnEdge(
  definition: ViewDefinition,
  source: string,
  target: string,
  kind: AddableKind,
  firstField: string,
): { definition: ViewDefinition; node: string } {
  const node = uniqueNodeId(NODE_TITLES[kind], Object.keys(definition.nodes));
  const nodes: Record<string, ViewNode> = {};
  for (const [id, existing] of Object.entries(definition.nodes)) {
    nodes[id] = id === target ? withInputReplaced(existing, source, node) : existing;
  }
  nodes[node] = { ...newNode(kind, source, firstField), label: NODE_TITLES[kind] };
  return {
    node,
    definition: {
      nodes,
      result: {
        ...definition.result,
        node: target === "result" ? node : definition.result.node,
      },
    },
  };
}

function distinctInputsOf(node: ViewNode): string[] {
  switch (node.kind) {
    case "source":
      return [];
    case "join":
      return [...new Set([node.left, node.right])];
    case "stack":
      return [...new Set(node.inputs.map((input) => input.node))];
    case "sql":
      return [...new Set([node.from, ...(node.reads ?? [])])];
    default:
      return [node.from];
  }
}

/** Why a node can't be removed right now, or undefined. */
export function removeBlocker(definition: ViewDefinition, id: string): string | undefined {
  const node = definition.nodes[id];
  if (node === undefined) {
    return undefined;
  }
  const readers = Object.entries(definition.nodes).filter(
    ([other, candidate]) => other !== id && distinctInputsOf(candidate).includes(id),
  );
  const inputs = distinctInputsOf(node);
  if (readers.length === 0 && definition.result.node !== id) {
    return undefined;
  }
  if (inputs.length === 1) {
    return undefined;
  }
  return definition.result.node === id && readers.length === 0
    ? "Pick another result node first."
    : `Used by ${readers.map(([other]) => other).join(", ")}. Remove or rewire those first.`;
}

/** The definition without node `id`; readers (and the result) reconnect to its single input. */
export function removeNode(definition: ViewDefinition, id: string): ViewDefinition {
  const node = definition.nodes[id];
  const [input] = node === undefined ? [] : distinctInputsOf(node);
  const nodes: Record<string, ViewNode> = {};
  for (const [other, candidate] of Object.entries(definition.nodes)) {
    if (other === id) {
      continue;
    }
    nodes[other] =
      input === undefined || !distinctInputsOf(candidate).includes(id)
        ? candidate
        : withInputReplaced(candidate, id, input);
  }
  const result =
    definition.result.node === id ? (input ?? Object.keys(nodes)[0] ?? "") : definition.result.node;
  return { nodes, result: { ...definition.result, node: result } };
}

/** The ancestor subgraph of `id` as its own definition (no output projection): what a node preview compiles. */
export function subgraphOf(definition: ViewDefinition, id: string): ViewDefinition {
  return pruneNodes({
    nodes: definition.nodes,
    result: { node: id, output: emptyOutput() },
  });
}

/** Node ids in dependency order (what feeds the result first), then nodes the result does not need. */
export function outlineOrder(definition: ViewDefinition): string[] {
  const order: string[] = [];
  const visit = (id: string, stack: string[]): void => {
    const node = definition.nodes[id];
    if (order.includes(id) || stack.includes(id) || node === undefined) {
      return;
    }
    for (const input of distinctInputsOf(node)) {
      visit(input, [...stack, id]);
    }
    order.push(id);
  };
  visit(definition.result.node, []);
  const used = new Set(order);
  for (const id of Object.keys(definition.nodes)) {
    visit(id, []);
  }
  return [...order.filter((id) => used.has(id)), ...order.filter((id) => !used.has(id))];
}

/** What the editor calls a node: its label, a source's dataset title, else its id. */
export function nodeLabel(
  definition: ViewDefinition,
  infos: readonly InputInfo[],
  id: string,
): string {
  const node = definition.nodes[id];
  if (node === undefined) {
    return id;
  }
  if (node.label !== undefined && node.label !== "") {
    return node.label;
  }
  const info = node.kind === "source" ? infos.find((entry) => entry.alias === id) : undefined;
  return info === undefined ? id : info.title;
}

/** Picker options for the nodes a node may read: every node except itself, labelled (the id when labels collide). */
export function nodeOptions(
  definition: ViewDefinition,
  infos: readonly InputInfo[],
  exclude: readonly string[] = [],
): { value: string; label: string }[] {
  const ids = Object.keys(definition.nodes).filter((id) => !exclude.includes(id));
  return ids.map((id) => {
    const label = nodeLabel(definition, infos, id);
    const clash = Object.keys(definition.nodes).some(
      (other) => other !== id && nodeLabel(definition, infos, other) === label,
    );
    return { value: id, label: clash ? `${label} (${id})` : label };
  });
}

/** Field names per node (`undefined` = unknown), from the same scope the validator uses. */
export function fieldNamesByNode(
  definition: ViewDefinition,
  infos: readonly InputInfo[],
): Map<string, string[] | undefined> {
  const fields = nodeFields(definition, toCompileMeta(infos));
  return new Map(
    [...fields].map(([id, map]) => [id, map === undefined ? undefined : [...map.keys()]]),
  );
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

function joinProblem(node: JoinNode): string | undefined {
  if (node.right === "" || node.left === "") {
    return "Pick the two nodes to join.";
  }
  if (node.on.length === 0 || node.on.some((pair) => pair.left === "" || pair.right === "")) {
    return "Pick the key fields on both sides.";
  }
  const { multiMatch } = node;
  const measures = multiMatch.mode === "summarize" ? multiMatch.measures : [];
  const measure = measures.map((m) => measureProblem(m)).find(isSet);
  return multiMatchProblem(multiMatch) ?? measure;
}

function columnsProblem(edits: ColumnEdit[]): string | undefined {
  return edits.some((edit) => "as" in edit && edit.as.trim() === "")
    ? "Name every renamed column."
    : undefined;
}

function calculateProblem(fields: { field: string; expr: string }[]): string | undefined {
  if (fields.length === 0) {
    return "Add a field to calculate.";
  }
  if (fields.some((field) => field.field.trim() === "")) {
    return "Name every new field.";
  }
  return fields.some((field) => field.expr.trim() === "")
    ? "Write the expression for every field."
    : undefined;
}

/** Whether a node is complete enough to compile (the editor shows the rest as "needs ..."). */
export function nodeProblem(node: ViewNode): string | undefined {
  switch (node.kind) {
    case "join":
      return joinProblem(node);
    case "stack":
      return node.inputs.length === 0 || node.inputs.some((input) => input.node === "")
        ? "Pick every node to stack."
        : undefined;
    case "filter": {
      const leaves = filterLeaves(node.where);
      return leaves === undefined || (leaves.length > 0 && leaves.every((l) => l.field !== ""))
        ? undefined
        : "Pick a field to filter on.";
    }
    case "groupBy":
      if (node.by.length === 0 || node.by.some((field) => field === "")) {
        return "Pick at least one field to group by.";
      }
      return node.measures.map((measure) => measureProblem(measure)).find(isSet);
    case "columns":
      return columnsProblem(node.edits);
    case "calculate":
      return calculateProblem(node.fields);
    case "sql":
      return node.query.trim() === "" ? "Write the SQL query." : undefined;
    default:
      return undefined;
  }
}

/** The first incomplete node among the ancestors of `id` ("Filter rows: Pick a field…"), or undefined. */
export function firstProblem(
  definition: ViewDefinition,
  ids: readonly string[],
): string | undefined {
  for (const id of ids) {
    const node = definition.nodes[id];
    const problem = node === undefined ? undefined : nodeProblem(node);
    if (problem !== undefined) {
      return `${id}: ${problem}`;
    }
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

/**
 * The join after its right side was re-picked: the right key fields of the
 * old side no longer apply, and a default prefix follows the new title.
 */
export function repointRight(
  step: JoinNode,
  right: string,
  titles: { old: string; next: string },
): JoinNode {
  if (step.right === right) {
    return step;
  }
  const oldDefault = slugifyViewName(titles.old);
  const usesDefault = step.prefix === undefined || step.prefix === "" || step.prefix === oldDefault;
  return {
    ...step,
    right,
    on: step.on.map((pair) => ({ ...pair, right: "" })),
    prefix: usesDefault ? slugifyViewName(titles.next) : step.prefix,
  };
}

/** Adds one manual key-map entry (from -> to) to a join, replacing an earlier entry for the same `from`. */
export function withManualMapEntry(step: JoinNode, from: string, to: string): JoinNode {
  const existing = (step.matching.manualMap ?? []).filter((entry) => entry.from !== from);
  return { ...step, matching: { ...step.matching, manualMap: [...existing, { from, to }] } };
}

export function withoutManualMapEntry(step: JoinNode, from: string): JoinNode {
  const remaining = (step.matching.manualMap ?? []).filter((entry) => entry.from !== from);
  const { manualMap: _dropped, ...rest } = step.matching;
  return {
    ...step,
    matching: remaining.length === 0 ? rest : { ...rest, manualMap: remaining },
  };
}

/** `prefix.name`, or just the name when the prefix is empty. */
export function prefixedName(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}.${name}`;
}

/** A one-line description of a node for the list and the canvas. */
export function nodeSummary(
  definition: ViewDefinition,
  infos: readonly InputInfo[],
  id: string,
): string {
  const node = definition.nodes[id];
  const label = (other: string): string =>
    other === "" ? "…" : nodeLabel(definition, infos, other);
  switch (node.kind) {
    case "source": {
      const info = infos.find((entry) => entry.alias === id);
      return info === undefined ? "Dataset" : info.title;
    }
    case "filter": {
      const leaves = filterLeaves(node.where);
      return leaves === undefined
        ? "Custom filter"
        : leaves.length === 0
          ? "Filter"
          : leaves.map((leaf) => `${leaf.field || "…"} ${opLabel(leaf.op)}`).join(" and ");
    }
    case "join": {
      const mode = node.multiMatch.mode;
      const policy = mode === "first" || mode === "last" ? `${mode} match` : mode;
      return `${label(node.left)} + ${label(node.right)} (${node.type}, ${policy})`;
    }
    case "stack":
      return node.inputs.map((input) => label(input.node)).join(" + ");
    case "groupBy":
      return `by ${node.by.join(", ") || "…"}`;
    case "columns":
      return node.edits.length === 0 ? "No changes yet" : `${node.edits.length} column edits`;
    case "calculate":
      return node.fields.map((field) => field.field || "…").join(", ");
    default:
      return "Custom SQL";
  }
}

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
      node: info.alias,
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

/** The source rows `save_view` / the preview take (`alias` = the source node id), from the definition itself. */
export function inputRefsOf(
  definition: ViewDefinition,
): { alias: string; datasetId: string; pinnedVersion?: string }[] {
  return Object.entries(definition.nodes).flatMap(([id, node]) =>
    node.kind !== "source"
      ? []
      : [
          node.ref.version === undefined
            ? { alias: id, datasetId: node.ref.id }
            : { alias: id, datasetId: node.ref.id, pinnedVersion: node.ref.version },
        ],
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
 * "Save as view" (#306): one `sql` node holding the query UNCHANGED (minus a
 * trailing `;`). The scratch names ARE the compiler's CTE names (`in_<id>`),
 * so each table the query reads becomes a source node of that id and a read of
 * the sql node. `baseAlias` is the table whose rows and geometry the view keeps.
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
  const nodes: Record<string, ViewNode> = {};
  for (const table of referenced) {
    nodes[table.alias] = { kind: "source", ref: { kind: "dataset", id: table.datasetId } };
  }
  const id = uniqueNodeId("query", Object.keys(nodes));
  nodes[id] = {
    kind: "sql",
    from: baseAlias,
    reads: referenced.map((table) => table.alias).filter((alias) => alias !== baseAlias),
    query: sql.replace(/[\s;]+$/, "").trim(),
  };
  return { nodes, result: { node: id, output: emptyOutput() } };
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
 * "Create view from relation" (replaces "Join into a table"): a source node for
 * each side and one join node on the relation's keys. A 1-1 relation takes the
 * first match; anything else summarizes with a count so no row is silently
 * dropped or multiplied.
 */
export function definitionFromRelation(seed: RelationSeed): {
  title: string;
  definition: ViewDefinition;
} {
  const left = uniqueNodeId(seed.fromTitle, []);
  const right = uniqueNodeId(seed.toTitle, [left]);
  const prefix = slugifyViewName(seed.toTitle);
  const join: JoinNode = {
    kind: "join",
    left,
    right,
    on: [{ left: seed.fromKey, right: seed.toKey }],
    matching: { ...DEFAULT_MATCHING },
    type: "left",
    multiMatch:
      seed.cardinality === "1-1"
        ? { mode: "first" }
        : { mode: "summarize", measures: [{ as: `${prefix}_count`, fn: "count" }] },
    ...(seed.cardinality === "1-1" ? { prefix } : {}),
  };
  const id = uniqueNodeId("joined", [left, right]);
  return {
    title: `${seed.fromTitle} + ${seed.toTitle}`,
    definition: {
      nodes: {
        [left]: { kind: "source", ref: { kind: "dataset", id: seed.fromDataset } },
        [right]: { kind: "source", ref: { kind: "dataset", id: seed.toDataset } },
        [id]: join,
      },
      result: { node: id, output: emptyOutput() },
    },
  };
}

/** The first validation problem as one sentence, noting how many more there are. */
export function validationSummary(errors: readonly { message: string }[]): string {
  const [first] = errors;
  const head = first === undefined ? "The steps are not valid yet." : first.message;
  return errors.length > 1 ? `${head} (and ${errors.length - 1} more)` : head;
}

/** The validation errors at or under `nodes.<id>`. */
export function errorsForNode(errors: readonly ValidationError[], id: string): ValidationError[] {
  const path = `nodes.${id}`;
  return errors.filter(
    (error) =>
      error.path === path || error.path.startsWith(`${path}.`) || error.path.startsWith(`${path}[`),
  );
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
/** Where in the step a validation error points, in the form's own words (the part of `path` after the node). */
export function errorLabel(path: string, nodePath: string): string {
  const tail = path === nodePath ? "" : path.slice(nodePath.length).replace(/^\./, "");
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

/**
 * Declared field types of one input dataset's stored JSON Schema (#335) — the
 * calculate form names a result type instead of "depends on the data" when a
 * field's type is declared. A local minimal reader: the datasets feature's
 * richer one is off-limits across the feature boundary (no-restricted-imports),
 * and views only needs this name→base-type shape.
 */
export function declaredViewFieldTypes(schema: unknown): Map<string, FieldType> {
  const types = new Map<string, FieldType>();
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return types;
  }
  for (const [name, raw] of Object.entries(schema.properties)) {
    const node = isRecord(raw) ? raw : {},
      base = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
    if (base === "number" || base === "integer") {
      types.set(name, "number");
    } else if (base === "boolean") {
      types.set(name, "boolean");
    } else if (base === "string") {
      types.set(name, "string");
    }
  }
  return types;
}
