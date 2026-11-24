import type { ColumnEdit } from "@caden/data-core/views";

/** The column names a `columns` node's edits leave (renames applied, drops removed), in field order. */
export function editedNames(fields: readonly string[], edits: readonly ColumnEdit[]): string[] {
  return fields.flatMap((field) => {
    const edit = edits.find((candidate) => candidate.from === field);
    if (edit === undefined) {
      return [field];
    }
    return "as" in edit ? [edit.as] : [];
  });
}

/** `only` after turning "keep only some columns" on (every current column, in order) or off (undefined). */
export function toggleOnly(
  only: readonly string[] | undefined,
  names: readonly string[],
): string[] | undefined {
  return only === undefined ? [...names] : undefined;
}

/** The names the edits leave that `only` does not list yet. */
export function missingFromOnly(only: readonly string[], names: readonly string[]): string[] {
  return names.filter((name) => !only.includes(name));
}
