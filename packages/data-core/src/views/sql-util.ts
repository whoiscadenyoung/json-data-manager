/**
 * SQL building blocks shared by the view compiler. Identifiers are quoted
 * here; every value (including jsonb keys) is a bind parameter. Nothing
 * user-supplied is spliced into SQL text.
 */

import { ViewCompileError } from "./errors.js";

/** quote_ident semantics: always double-quote, double any embedded quote. */
export function quoteIdent(name: string): string {
  if (name.includes("\0")) {
    throw new ViewCompileError("Identifiers cannot contain NUL characters.");
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/** The CTE name for an input alias. */
export function inputCteName(alias: string): string {
  return quoteIdent(`in_${alias}`);
}

/** Positional parameter registry; identical (value, cast) pairs share one slot. */
export class ParamBag {
  readonly values: unknown[] = [];
  private readonly slots = new Map<string, number>();

  /** Register a value and return its placeholder, e.g. `$3::text`. */
  add(value: unknown, cast: string): string {
    const key = `${cast}\u0000${JSON.stringify(value)}`;
    const existing = this.slots.get(key);
    if (existing !== undefined) {
      return `$${existing}::${cast}`;
    }
    this.values.push(value);
    const slot = this.values.length;
    this.slots.set(key, slot);
    return `$${slot}::${cast}`;
  }

  text(value: string): string {
    return this.add(value, "text");
  }

  /** jsonb params travel as pre-serialized JSON strings. */
  jsonb(value: unknown): string {
    return this.add(JSON.stringify(value), "jsonb");
  }
}

/** `d -> 'key'` (jsonb) with the key as a bind parameter. */
export function fieldJson(row: string, bag: ParamBag, field: string): string {
  return `(${row} -> ${bag.text(field)})`;
}

/** `d ->> 'key'` (text) with the key as a bind parameter. */
export function fieldText(row: string, bag: ParamBag, field: string): string {
  return `(${row} ->> ${bag.text(field)})`;
}

/** Numeric value of a jsonb number field; null for every other type. */
export function fieldNumber(row: string, bag: ParamBag, field: string): string {
  const json = fieldJson(row, bag, field);
  return `(case when jsonb_typeof(${json}) = 'number' then ${json}::numeric end)`;
}

/** SQL that is true when the jsonb field is present and not JSON null. */
export function fieldPresent(row: string, bag: ParamBag, field: string): string {
  const json = fieldJson(row, bag, field);
  return `(${json} is not null and jsonb_typeof(${json}) <> 'null')`;
}

const MAX_BUILD_ARGS_PAIRS = 40;

/**
 * `jsonb_build_object` over (key, valueSql) pairs, chunked so we stay under
 * Postgres' 100-argument function limit.
 */
export function buildObject(pairs: { key: string; value: string }[], bag: ParamBag): string {
  if (pairs.length === 0) {
    return "'{}'::jsonb";
  }
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += MAX_BUILD_ARGS_PAIRS) {
    const args = pairs
      .slice(i, i + MAX_BUILD_ARGS_PAIRS)
      .map((pair) => `${bag.text(pair.key)}, ${pair.value}`);
    chunks.push(`jsonb_build_object(${args.join(", ")})`);
  }
  return chunks.join(" || ");
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function containsUuid(text: string): boolean {
  return UUID_PATTERN.test(text);
}

/**
 * Slug-safe readable name for a dataset title: lowercase ASCII letters,
 * digits and underscores. Never empty, never a uuid.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "")
    .slice(0, 40)
    .replaceAll(/_+$/g, "");
  if (slug === "" || containsUuid(slug)) {
    return "input";
  }
  return slug;
}
