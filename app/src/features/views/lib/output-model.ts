import type { OutputField, OutputSchema } from "@caden/data-core/views";

/**
 * The Output card's model (issue #303). The saved `output.fields` list is the
 * single source of truth for keys, labels, hidden flags and order; an EMPTY
 * list means "every final field, as named". The card edits a flat list of
 * rows (one per final field: the kept ones in output order, then the left-out
 * ones) and converts back, collapsing to `[]` when nothing was customised.
 */

export interface OutputRow {
  /** The final field this column reads (the original name). */
  from: string;
  /** The output property name. */
  key: string;
  label: string;
  hidden: boolean;
  kept: boolean;
}

/** ArcGIS field names: a letter first, then letters, digits or underscores, at most 64 characters. */
const ARCGIS_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
export const ARCGIS_MAX_LENGTH = 64;

/** Why a key is not a valid ArcGIS field name, or `undefined` when it is one. */
export function arcGisProblem(key: string): string | undefined {
  if (key === "") {
    return undefined;
  }
  if (!/^[A-Za-z]/.test(key)) {
    return "ArcGIS field names must start with a letter.";
  }
  if (!ARCGIS_NAME.test(key)) {
    return "ArcGIS field names use only letters, digits and underscores.";
  }
  if (key.length > ARCGIS_MAX_LENGTH) {
    return `ArcGIS field names are at most ${ARCGIS_MAX_LENGTH} characters.`;
  }
  return undefined;
}

function rowOfField(field: OutputField): OutputRow {
  return {
    from: field.from ?? field.key,
    key: field.key,
    label: field.label ?? "",
    hidden: field.hidden === true,
    kept: true,
  };
}

/**
 * The rows for the card. `fields` are the view's final field names (in their
 * natural order), or `undefined` while the steps are incomplete.
 */
export function outputRowsOf(
  output: OutputSchema,
  fields: readonly string[] | undefined,
): OutputRow[] {
  const natural = fields ?? [];
  if (output.fields.length === 0) {
    return natural.map((name) => ({
      from: name,
      key: name,
      label: "",
      hidden: false,
      kept: true,
    }));
  }
  const kept = output.fields.map((field) => rowOfField(field));
  const used = new Set(kept.map((row) => row.from));
  const left = natural
    .filter((name) => !used.has(name))
    .map((name) => ({ from: name, key: name, label: "", hidden: false, kept: false }));
  return [...kept, ...left];
}

function isDefaultRow(row: OutputRow): boolean {
  return row.key === row.from && row.label === "" && !row.hidden;
}

/** The `output.fields` list for these rows (`[]` when nothing differs from "every field as named"). */
export function outputFieldsOf(
  rows: readonly OutputRow[],
  fields: readonly string[] | undefined,
): OutputField[] {
  const kept = rows.filter((row) => row.kept);
  const natural = fields ?? [];
  const untouched =
    kept.length === rows.length &&
    kept.length === natural.length &&
    kept.every((row, index) => isDefaultRow(row) && row.from === natural[index]);
  if (untouched) {
    return [];
  }
  return kept.map((row) => ({
    key: row.key,
    ...(row.from === row.key ? {} : { from: row.from }),
    ...(row.label === "" ? {} : { label: row.label }),
    ...(row.hidden ? { hidden: true } : {}),
  }));
}

/** Replace one row. */
export function patchRow(
  rows: readonly OutputRow[],
  index: number,
  patch: Partial<OutputRow>,
): OutputRow[] {
  return rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
}

/** Move a KEPT row one place among the kept rows (the left-out ones stay at the end). */
export function moveRow(rows: readonly OutputRow[], index: number, direction: -1 | 1): OutputRow[] {
  const target = index + direction;
  const here = rows[index];
  const there = rows[target];
  if (here === undefined || there === undefined || !here.kept || !there.kept) {
    return [...rows];
  }
  return rows.map((row, i) => {
    if (i === index) {
      return there;
    }
    return i === target ? here : row;
  });
}

/** Keep or leave out a field; a field that comes back lands at the end of the kept ones. */
export function setKept(rows: readonly OutputRow[], index: number, kept: boolean): OutputRow[] {
  const row = rows[index];
  if (row === undefined || row.kept === kept) {
    return [...rows];
  }
  const keptRows = rows.filter((candidate, i) => candidate.kept && i !== index);
  const left = rows.filter((candidate, i) => !candidate.kept && i !== index);
  return kept
    ? [...keptRows, { ...row, kept: true }, ...left]
    : [...keptRows, ...left, { ...row, kept: false }];
}

export interface RowProblems {
  /** The key is empty. */
  empty: boolean;
  /** Another kept field has the same key. */
  duplicate: boolean;
  /** Why the key is not an ArcGIS field name (hidden fields are not exported, so they never warn). */
  arcgis: string | undefined;
}

/** Warnings per row index. Left-out rows have none. */
export function rowProblems(rows: readonly OutputRow[]): RowProblems[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.kept) {
      counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    }
  }
  return rows.map((row) => {
    if (!row.kept) {
      return { empty: false, duplicate: false, arcgis: undefined };
    }
    return {
      empty: row.key === "",
      duplicate: row.key !== "" && (counts.get(row.key) ?? 0) > 1,
      arcgis: row.hidden ? undefined : arcGisProblem(row.key),
    };
  });
}

/** A one-line description of a rename, shown next to the key: `original → new`. */
export function renameNote(row: OutputRow): string | undefined {
  return row.key !== row.from ? `${row.from} → ${row.key}` : undefined;
}
