import type { ViewDefinition } from "@caden/data-core/views";

import type { Graph, GraphEdge, GraphNode, StepSelection } from "./graph-types";

/**
 * Steps are read loosely on purpose. The real `Step` union is closed, but
 * stored definitions can hold step kinds this build doesn't know yet (spatial
 * steps are planned), and those must still draw as generic nodes.
 */
type Loose = Record<string, unknown>;

const STEP_TITLES: Record<string, string> = {
  calculate: "Calculate",
  filter: "Filter",
  groupBy: "Group by",
  join: "Join",
  select: "Select fields",
  sql: "SQL",
};

function isLoose(value: unknown): value is Loose {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looseOf(value: unknown): Loose {
  return isLoose(value) ? value : {};
}

function looseList(value: unknown): Loose[] {
  return Array.isArray(value) ? value.map(looseOf) : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function kindOf(step: Loose): string {
  const kind = step["kind"];
  return typeof kind === "string" && kind !== "" ? kind : "unknown";
}

/** A join's right side: `{ input, steps? }`. */
function rightOf(step: Loose): { input: string | undefined; steps: Loose[] } {
  const right = looseOf(step["right"]);
  const input = right["input"];
  return { input: typeof input === "string" ? input : undefined, steps: looseList(right["steps"]) };
}

function joinDetail(step: Loose): string | undefined {
  const { input } = rightOf(step);
  const type = step["type"] === "inner" ? "Inner" : "Left";
  return input === undefined ? undefined : `${type} join ${input}`;
}

const DETAIL: Record<string, (step: Loose) => string | undefined> = {
  calculate: (step) => {
    const field = step["field"];
    return typeof field === "string" ? field : undefined;
  },
  groupBy: (step) => {
    const by = stringsOf(step["by"]);
    return by.length === 0 ? undefined : `by ${by.join(", ")}`;
  },
  join: joinDetail,
  select: (step) => {
    const fields = step["fields"];
    return Array.isArray(fields) ? `${fields.length} fields` : undefined;
  },
};

function stepNode(step: Loose, selection: StepSelection, id: string): GraphNode {
  const kind = kindOf(step);
  const detail = DETAIL[kind];
  return {
    detail: detail === undefined ? undefined : detail(step),
    id,
    kind: "step",
    label: STEP_TITLES[kind] ?? kind,
    step: selection,
    stepKind: kind,
  };
}

const stepNodeId = (selection: StepSelection) =>
  selection.sub === undefined
    ? `step:${selection.index}`
    : `step:${selection.index}.${selection.sub}`;

class StepGraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  addNode(node: GraphNode): void {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
  }

  /** An input referenced by a step but missing from `inputs` still gets a node. */
  ensureInput(alias: string): string {
    const id = `input:${alias}`;
    this.addNode({ id, kind: "input", label: alias });
    return id;
  }

  addEdge(source: string, target: string, kind: GraphEdge["kind"]): void {
    const id = `${kind}:${source}>${target}`;
    if (!this.edges.has(id)) {
      this.edges.set(id, { id, kind, source, target });
    }
  }
}

/** Adds a join's sub-pipeline as a chain from the right input into the join step. */
function addBranch(builder: StepGraphBuilder, step: Loose, index: number, joinId: string): void {
  const right = rightOf(step);
  let previous = right.input === undefined ? undefined : builder.ensureInput(right.input);
  for (const [subIndex, sub] of right.steps.entries()) {
    const selection = { index, sub: subIndex };
    const id = stepNodeId(selection);
    builder.addNode(stepNode(sub, selection, id));
    const nested = rightOf(sub).input;
    if (kindOf(sub) === "join" && nested !== undefined) {
      // A join inside a sub-pipeline reads its own right input.
      builder.addEdge(builder.ensureInput(nested), id, "branch");
    }
    if (previous !== undefined) {
      builder.addEdge(previous, id, "branch");
    }
    previous = id;
  }
  if (previous !== undefined) {
    builder.addEdge(previous, joinId, "branch");
  }
}

/**
 * The view step graph (design §9): inputs, then the steps in order, then the
 * output. The base input feeds the first step; a join's right input feeds the
 * join step directly, or through the nodes of its inline sub-pipeline
 * (`right.steps`). Unknown step kinds draw as generic nodes. Pure and total:
 * malformed or partial definitions produce a smaller graph, never an error.
 */
export function buildViewStepGraph(definition: ViewDefinition): Graph {
  const builder = new StepGraphBuilder();
  const loose = looseOf(definition);
  for (const input of looseList(loose["inputs"])) {
    const alias = input["alias"];
    if (typeof alias === "string") {
      builder.ensureInput(alias);
    }
  }
  const base = loose["base"];
  let previous = typeof base === "string" && base !== "" ? builder.ensureInput(base) : undefined;

  for (const [index, step] of looseList(loose["steps"]).entries()) {
    const selection = { index };
    const id = stepNodeId(selection);
    builder.addNode(stepNode(step, selection, id));
    if (previous !== undefined) {
      builder.addEdge(previous, id, "flow");
    }
    if (kindOf(step) === "join") {
      addBranch(builder, step, index, id);
    }
    previous = id;
  }

  builder.addNode({ id: "output", kind: "output", label: "Output" });
  if (previous !== undefined) {
    builder.addEdge(previous, "output", "flow");
  }
  return { edges: [...builder.edges.values()], nodes: [...builder.nodes.values()] };
}

/** The graph node id of a step selection (for highlighting the selected step). */
export function stepGraphNodeId(selection: StepSelection): string {
  return stepNodeId(selection);
}
