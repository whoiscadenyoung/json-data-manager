/**
 * Suggested key pairs for a link between two datasets: field names both sides
 * share (compared ignoring case and punctuation, so `UEI` matches `uei` and
 * `Fiscal Year` matches `fiscal_year`). Exact-name matches come first.
 */
export interface KeySuggestion {
  fromKey: string;
  toKey: string;
}

export function canon(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

/** Row ids and shape columns match by accident across datasets; they are never the first suggestion. */
const ROW_ID_NAME = /^(objectid|fid|id|globalid|gid|shape.*|geometry)$/;

function rank(suggestion: KeySuggestion): number {
  return (
    (ROW_ID_NAME.test(canon(suggestion.fromKey)) ? 2 : 0) +
    (suggestion.fromKey === suggestion.toKey ? 0 : 1)
  );
}

export function suggestKeys(
  fromProps: readonly string[],
  toProps: readonly string[],
): KeySuggestion[] {
  const out: KeySuggestion[] = [];
  for (const fromKey of fromProps) {
    const match =
      toProps.find((candidate) => candidate === fromKey) ??
      toProps.find((candidate) => canon(candidate) === canon(fromKey) && canon(fromKey) !== "");
    if (match !== undefined) {
      out.push({ fromKey, toKey: match });
    }
  }
  return out.toSorted((a, b) => rank(a) - rank(b));
}
