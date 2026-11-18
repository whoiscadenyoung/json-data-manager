/** Column edits shared by `columns` nodes and stack edges. */
import { ParamBag } from "./sql-util.js";
import type { AppendTag, ColumnEdit } from "./types.js";

/** Row object after column edits (all reads use the original row, so swaps work). */
export function editedRow(edits: ColumnEdit[] | undefined, bag: ParamBag): string {
  if (edits === undefined || edits.length === 0) {
    return "d";
  }
  const dropped = edits.map((edit) => ` - ${bag.text(edit.from)}`).join("");
  const moved = edits
    .filter((edit): edit is { from: string; as: string } => "as" in edit)
    .map(
      (edit) =>
        `case when jsonb_exists(d, ${bag.text(edit.from)}) then jsonb_build_object(${bag.text(edit.as)}, d -> ${bag.text(edit.from)}) else '{}'::jsonb end`,
    );
  return [`(d${dropped})`, ...moved].join(" || ");
}

/** Edited row, with the stack tag stamped onto it when both a field and a tag are given. */
export function tagPatch(
  field: string | undefined,
  tag: AppendTag | undefined,
  edits: ColumnEdit[] | undefined,
  bag: ParamBag,
): string {
  const row = editedRow(edits, bag);
  if (field === undefined || tag === undefined) {
    return row;
  }
  return `${row} || jsonb_build_object(${bag.text(field)}, ${bag.jsonb(tag)})`;
}

/** The row restricted to `only` (when given), keeping only keys that are present. */
export function onlyRow(row: string, only: string[] | undefined, bag: ParamBag): string {
  if (only === undefined) {
    return row;
  }
  const wanted = bag.jsonb(only);
  return `coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(${row}) e where e.key in (select jsonb_array_elements_text(${wanted}))), '{}'::jsonb)`;
}
