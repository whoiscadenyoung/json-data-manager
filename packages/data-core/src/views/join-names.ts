/**
 * Output field names of a join, shared by the compiler and the field-scope
 * walk so the two always agree.
 */

import { slugify } from "./sql-util.js";

/** The prefix for joined fields: explicit, or a readable slug of the right input's title. */
export function joinPrefix(step: { prefix?: string }, title: string): string {
  return step.prefix ?? slugify(title);
}

/** `<prefix>.<name>`, or just the name when the prefix is empty. */
export function prefixed(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}.${name}`;
}

/** The single property a `list` multi-match writes its array to. */
export function listKey(prefix: string, title: string): string {
  return prefix === "" ? slugify(title) : prefix;
}
