import { classBreaks, distinctValues, numericValues } from "./classify";
import { categoryColor, OTHER_COLOR, rampColors, type RampName } from "./palettes";
import type { Renderer } from "./validators";

/** Classes the editor generates for a categories style (the rest fall into "Other"). */
export const MAX_GENERATED_CATEGORIES = 12;

/** Rows scanned to discover a dataset's field names. */
const FIELD_SCAN_ROWS = 2000;

type Records = ReadonlyArray<Record<string, unknown>>;

/** Field names across the first rows' records, sorted. */
export function fieldNames(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  for (const record of records.slice(0, FIELD_SCAN_ROWS)) {
    for (const key of Object.keys(record)) {
      names.add(key);
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

/** Fields with at least one numeric value (graduated styles need numbers). */
export function numericFieldNames(
  records: ReadonlyArray<Record<string, unknown>>,
  fields: readonly string[],
): string[] {
  return fields.filter(
    (field) =>
      numericValues(records.slice(0, FIELD_SCAN_ROWS).map((record) => record[field])).length > 0,
  );
}

interface FieldProfile {
  field: string;
  distinct: number;
  present: number;
  isText: boolean;
}

/** 2–12 distinct values: a legend people can read. */
function hasFewClasses(item: FieldProfile): boolean {
  return item.distinct >= 2 && item.distinct <= MAX_GENERATED_CATEGORIES;
}

/** Some value is shared by several features (ids and measurements never are). */
function hasRepeats(item: FieldProfile): boolean {
  return item.distinct > 0 && item.distinct < item.present;
}

function profileField(records: Records, field: string): FieldProfile {
  const values = records.map((record) => record[field]);
  return {
    distinct: distinctValues(values).length,
    field,
    isText: values.some((value) => typeof value === "string"),
    present: values.filter((value) => value !== undefined && value !== null).length,
  };
}

/**
 * The field a fresh categories style starts on: the first text field whose
 * values form a handful of shared classes (2–12 distinct values, some
 * repeated), then any such field, then any field with repeats, then the
 * first field. Alphabetical-first alone picks ids and measurements, where
 * every feature is its own class.
 */
export function bestCategoryField(records: Records, fields: readonly string[]): string | undefined {
  const scanned = records.slice(0, FIELD_SCAN_ROWS),
    profiles = fields.map((field) => profileField(scanned, field)),
    pick =
      profiles.find((item) => item.isText && hasFewClasses(item) && hasRepeats(item)) ??
      profiles.find((item) => hasFewClasses(item) && hasRepeats(item)) ??
      profiles.find(hasRepeats) ??
      profiles.at(0);
  return pick === undefined ? undefined : pick.field;
}

/** A categories renderer over a field's most frequent values. */
export function categoricalRenderer(field: string, values: readonly unknown[]): Renderer {
  const distinct = distinctValues(values).slice(0, MAX_GENERATED_CATEGORIES);
  return {
    categories: distinct.map((item, index) => ({ color: categoryColor(index), value: item.value })),
    field,
    kind: "categorical",
    otherColor: OTHER_COLOR,
  };
}

/** A graduated renderer: breaks from the values, colors from the ramp. */
export function graduatedRenderer(
  field: string,
  values: readonly unknown[],
  options: { method: "equal" | "quantile"; classes: number; ramp: RampName },
): Renderer {
  const breaks = classBreaks(numericValues(values), options.classes, options.method);
  return {
    breaks,
    colors: rampColors(options.ramp, breaks.length + 1),
    field,
    kind: "graduated",
    method: options.method,
    ramp: options.ramp,
  };
}

/** How many distinct values a field has beyond the generated categories (for the "+N more in Other" note). */
export function overflowCount(values: readonly unknown[]): number {
  return Math.max(0, distinctValues(values).length - MAX_GENERATED_CATEGORIES);
}
