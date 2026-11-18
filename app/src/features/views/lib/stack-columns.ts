import type { ColumnEdit, ViewNode } from "@caden/data-core/views";

import { canon } from "../../datasets/lib/link-suggestions";

type StackNode = Extract<ViewNode, { kind: "stack" }>;

/** One stacked input: a node, with its column edits. */
export interface StackMember {
  label: string;
  /** Declared fields; undefined when unknown. */
  fields: string[] | undefined;
  edits: ColumnEdit[];
}

export type CellState = "plain" | "renamed" | "excluded";

export interface ColumnCell {
  member: number;
  from: string;
  state: CellState;
}

export interface ColumnRow {
  /** Output column name (for an excluded-only row, the dropped field's name). */
  name: string;
  cells: ColumnCell[];
  status: "merged" | "partial" | "excluded";
  renamed: boolean;
  /** Labels of the members that feed the column. */
  presentIn: string[];
}

export interface MergeSuggestion {
  /** Column kept. */
  into: string;
  /** Column renamed into `into`. */
  from: string;
}

/** Members of a stack, one per input. */
export function stackMembers(
  node: StackNode,
  fieldsOf: (id: string) => string[] | undefined,
  labelOf: (id: string) => string,
): StackMember[] {
  return node.inputs.map((input) => ({
    label: labelOf(input.node),
    fields: input.node === "" ? undefined : fieldsOf(input.node),
    edits: input.columns ?? [],
  }));
}

function cellFor(member: number, from: string, edits: ColumnEdit[]): ColumnCell & { out: string } {
  const edit = edits.find((candidate) => candidate.from === from);
  if (edit === undefined) {
    return { member, from, state: "plain", out: from };
  }
  if ("exclude" in edit) {
    return { member, from, state: "excluded", out: from };
  }
  return { member, from, state: edit.as === from ? "plain" : "renamed", out: edit.as };
}

function rowStatus(cells: ColumnCell[], total: number): ColumnRow["status"] {
  const active = cells.filter((cell) => cell.state !== "excluded").length;
  if (active === 0) {
    return "excluded";
  }
  return active < total ? "partial" : "merged";
}

/** The output column table: one row per output column, one cell per member that feeds it. */
export function deriveColumns(members: StackMember[]): ColumnRow[] {
  const rows = new Map<string, ColumnCell[]>();
  for (const [index, member] of members.entries()) {
    for (const field of member.fields ?? []) {
      const { out, ...cell } = cellFor(index, field, member.edits);
      // Excluded cells sit under the dropped field's own name.
      const list = rows.get(out) ?? [];
      list.push(cell);
      rows.set(out, list);
    }
  }
  return [...rows.entries()].map(([name, cells]) => {
    const present = new Set(cells.filter((c) => c.state !== "excluded").map((c) => c.member));
    return {
      name,
      cells,
      status: rowStatus(cells, members.length),
      renamed: cells.some((cell) => cell.state === "renamed"),
      presentIn: members.filter((_, i) => present.has(i)).map((member) => member.label),
    };
  });
}

/** Output field names after the edits, in first-seen order. */
export function outputFields(members: StackMember[]): string[] {
  return deriveColumns(members)
    .filter((row) => row.status !== "excluded")
    .map((row) => row.name);
}

function withEdit(edits: ColumnEdit[], from: string, edit: ColumnEdit | undefined): ColumnEdit[] {
  const rest = edits.filter((candidate) => candidate.from !== from);
  return edit === undefined ? rest : [...rest, edit];
}

/** Replace one member's edits. Empty lists are dropped. */
export function setMemberEdits(node: StackNode, member: number, edits: ColumnEdit[]): StackNode {
  const value = edits.length === 0 ? undefined : edits;
  return {
    ...node,
    inputs: node.inputs.map((input, i) => {
      if (i !== member) {
        return input;
      }
      const { columns: _old, ...rest } = input;
      return value === undefined ? rest : { ...rest, columns: value };
    }),
  };
}

/** Toggle whether a member drops one of its fields. */
export function toggleExclude(
  step: StackNode,
  member: number,
  edits: ColumnEdit[],
  from: string,
): StackNode {
  const current = edits.find((edit) => edit.from === from);
  const next =
    current !== undefined && "exclude" in current
      ? withEdit(edits, from, undefined)
      : withEdit(edits, from, { from, exclude: true });
  return setMemberEdits(step, member, next);
}

/** Rename an output column in every member that feeds it. */
export function renameColumn(
  step: StackNode,
  members: StackMember[],
  row: ColumnRow,
  to: string,
): StackNode {
  let next = step;
  for (const cell of row.cells) {
    if (cell.state === "excluded") {
      continue;
    }
    const edits = members[cell.member].edits;
    const edit: ColumnEdit | undefined = to === cell.from ? undefined : { from: cell.from, as: to };
    next = setMemberEdits(next, cell.member, withEdit(edits, cell.from, edit));
  }
  return next;
}

/**
 * Make a member feed output column `column` from `source` (undefined = no
 * field). A field of that name the member already has is dropped, since the
 * output column can only come from one place per member.
 */
export function mapCell(
  step: StackNode,
  member: StackMember,
  index: number,
  column: string,
  source: string | undefined,
): StackNode {
  let edits = member.edits.filter((edit) => !("as" in edit && edit.as === column));
  const natural = (member.fields ?? []).includes(column);
  if (natural && source !== column) {
    edits = withEdit(edits, column, { from: column, exclude: true });
  } else if (natural) {
    edits = withEdit(edits, column, undefined);
  }
  if (source !== undefined && source !== column) {
    edits = withEdit(edits, source, { from: source, as: column });
  }
  return setMemberEdits(step, index, edits);
}

/** Pairs of partial columns that look like the same field (case/punctuation-insensitive) and never co-occur. */
export function suggestMerges(rows: ColumnRow[]): MergeSuggestion[] {
  const partial = rows.filter((row) => row.status === "partial");
  const out: MergeSuggestion[] = [];
  for (const [i, a] of partial.entries()) {
    for (const b of partial.slice(i + 1)) {
      const overlap = a.cells.some((x) => b.cells.some((y) => x.member === y.member));
      if (!overlap && canon(a.name) === canon(b.name) && canon(a.name) !== "") {
        out.push({ into: a.name, from: b.name });
      }
    }
  }
  return out;
}
