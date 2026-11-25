import type { PostgresType } from "postgres";

/**
 * json / jsonb parameters. The compiler hands jsonb params over as
 * PRE-SERIALIZED JSON strings (`$n::jsonb`), and postgres.js would otherwise
 * JSON.stringify them a second time into a JSON string scalar once the server
 * reports the parameter type as jsonb. Strings pass through untouched;
 * anything else is stringified. Results still parse to JS values.
 */
function passthrough(oid: number): PostgresType {
  return {
    to: oid,
    from: [oid],
    serialize: (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value)),
    parse: (text: string): unknown => JSON.parse(text),
  };
}

export const jsonPassthroughTypes = { json: passthrough(114), jsonb: passthrough(3802) };
