/**
 * Key-normalization & coercion policies for every pipeline that must treat
 * values from differently-typed sources as comparable: join keys (lookup
 * specs — docs/derived-datasets-design.md §6 "key hygiene") and typed
 * columns (analysis layer — docs/analysis-layer-design.md §2: "`GrantId` as
 * string in one file, number in another, is the same disease").
 *
 * Invariants, each pinned by a test in `coercion.test.ts`:
 *
 * - **Idempotent.** Applying any of these functions to its own output is a
 *   no-op, so callers can normalize eagerly without caring whether a value
 *   upstream was already normalized.
 * - **Conservative across the number/string divide.** Only the exact disease
 *   is healed: number `42` and string `"42"` join, but string `"007"` never
 *   joins number `7` — a string is trimmed and case-folded, never
 *   re-interpreted through `Number()`, so zero-padded identifiers stay
 *   distinct. Missed matches (rare float-notation splits) surface as
 *   unmatched rows in match-rate diagnostics rather than as wrong joins.
 * - **Explicit non-coercion.** Only numbers and strings coerce. Booleans,
 *   `null`/`undefined`, arrays and objects never do — dodging the
 *   `Number(true) === 1`, `Number("") === 0` and `Number([]) === 0`
 *   accidents — and already-normalized values pass through unchanged.
 */

/** Trimmed, lowercased copy of `text` — the trim + case policy for text comparison. */
export function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The number `value` already is, or the number its string form names after
 * trimming — `undefined` for everything else. Non-finite numbers and
 * non-numeric strings (including the empty string) have no numeric value;
 * booleans and non-primitives are refused rather than coerced through
 * `Number()`'s truthiness table. Shared by join keys (as the number-vs-string
 * policy) and column typing (a numeric column's string cells).
 *
 * `parseCoordinateValue` in `coordinate-columns.ts` is an alias of this
 * function — the dedupe roadmap stage 1 made when the lookup engine landed,
 * so the two implementations cannot drift.
 */
export function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Canonical join-key form of `value`, or `undefined` when it has none.
 * Numbers become their decimal string form, so number `42` and string
 * `"42"` — the same `GrantId` arriving differently-typed from two files —
 * produce the same key. Strings are trimmed and case-folded and are *not*
 * numeric-normalized, so `"007"` and number `7` stay distinct (see the
 * module invariants above). Whitespace-only strings, non-finite numbers and
 * every non-string/non-number value have no key at all: a row with no key is
 * an unmatched row, never a crash and never a match against `"null"`.
 */
export function normalizeKey(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "string") {
    const key = normalizeText(value);
    return key === "" ? undefined : key;
  }
  return undefined;
}
