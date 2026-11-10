/**
 * Join key normalization (design §6 / D12): trim, case folding, whitespace
 * collapsing, diacritic stripping and a manual key map. Both sides of a join
 * normalize identically; the manual map applies to the left key only.
 */

import { ParamBag } from "./sql-util.js";
import type { KeyMatching } from "./types.js";

const DIACRITIC_GROUPS: [string, string][] = [
  ["a", "àáâãäåāăą"],
  ["A", "ÀÁÂÃÄÅĀĂĄ"],
  ["c", "çćĉċč"],
  ["C", "ÇĆĈĊČ"],
  ["d", "ďđ"],
  ["D", "ĎĐ"],
  ["e", "èéêëēĕėęě"],
  ["E", "ÈÉÊËĒĔĖĘĚ"],
  ["g", "ĝğġģ"],
  ["G", "ĜĞĠĢ"],
  ["h", "ĥħ"],
  ["H", "ĤĦ"],
  ["i", "ìíîïĩīĭįı"],
  ["I", "ÌÍÎÏĨĪĬĮİ"],
  ["j", "ĵ"],
  ["J", "Ĵ"],
  ["k", "ķ"],
  ["K", "Ķ"],
  ["l", "ĺļľŀł"],
  ["L", "ĹĻĽĿŁ"],
  ["n", "ñńņň"],
  ["N", "ÑŃŅŇ"],
  ["o", "òóôõöøōŏő"],
  ["O", "ÒÓÔÕÖØŌŎŐ"],
  ["r", "ŕŗř"],
  ["R", "ŔŖŘ"],
  ["s", "śŝşš"],
  ["S", "ŚŜŞŠ"],
  ["t", "ţťŧ"],
  ["T", "ŢŤŦ"],
  ["u", "ùúûüũūŭůűų"],
  ["U", "ÙÚÛÜŨŪŬŮŰŲ"],
  ["w", "ŵ"],
  ["W", "Ŵ"],
  ["y", "ýÿŷ"],
  ["Y", "ÝŸŶ"],
  ["z", "źżž"],
  ["Z", "ŹŻŽ"],
];

/** `translate(x, from, to)` argument strings (one-to-one, same length). */
export function diacriticTranslation(): { from: string; to: string } {
  let from = "";
  let to = "";
  for (const [ascii, accented] of DIACRITIC_GROUPS) {
    for (const char of accented.normalize("NFC")) {
      from += char;
      to += ascii;
    }
  }
  return { from, to };
}

export interface KeyOptions {
  unaccent: boolean;
}

/**
 * The `(from, to)` VALUES CTE body for a manual key map, or undefined when
 * there is none.
 */
export function manualMapValues(matching: KeyMatching, bag: ParamBag): string | undefined {
  const map = matching.manualMap;
  if (map === undefined || map.length === 0) {
    return undefined;
  }
  const rows = map.map((entry) => `(${bag.text(entry.from)}, ${bag.text(entry.to)})`);
  return `values ${rows.join(", ")}`;
}

/**
 * The normalized key expression for a raw text key expression. `mapCte` is
 * the quoted name of the manual-map CTE (left side only).
 */
export function normalizeKey(
  raw: string,
  matching: KeyMatching,
  bag: ParamBag,
  options: KeyOptions,
  mapCte: string | undefined,
): string {
  let expr = raw;
  if (mapCte !== undefined) {
    expr = `coalesce((select m.k_to from ${mapCte} m where m.k_from = ${raw}), ${raw})`;
  }
  if (matching.stripDiacritics) {
    expr = stripDiacritics(expr, bag, options);
  }
  if (matching.collapseSpace) {
    expr = `regexp_replace(${expr}, '\\s+', ' ', 'g')`;
  }
  if (matching.caseFold) {
    expr = `lower(${expr})`;
  }
  if (matching.trim) {
    expr = `btrim(${expr})`;
  }
  return expr;
}

function stripDiacritics(expr: string, bag: ParamBag, options: KeyOptions): string {
  if (options.unaccent) {
    return `unaccent(${expr})`;
  }
  const { from, to } = diacriticTranslation();
  return `translate(${expr}, ${bag.text(from)}, ${bag.text(to)})`;
}
