import type {
  EntryRow,
  SearchEntriesArgs,
  SearchEntriesPage,
  SearchFilter,
} from "#/lib/store/entries";

/**
 * A live view's rows on the client (issue #305). The server returns the whole
 * (capped) result; there are no saved rows to page, so the table's search,
 * filter and sort run here over that result instead of in `search_entries`.
 */

export interface LiveWireRow {
  row_id?: unknown;
  d?: unknown;
  geom?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Live rows as entry rows. A live row has no entry id; one is derived from the source row id and its occurrence so React keys stay stable. */
export function liveRowsToEntries(viewId: string, rows: readonly LiveWireRow[]): EntryRow[] {
  const seen = new globalThis.Map<string, number>();
  return rows.map((row, index) => {
    const base = typeof row.row_id === "string" ? row.row_id : `r${index}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const geom = row.geom;
    return {
      id: occurrence === 1 ? `live:${base}` : `live:${base}:${occurrence}`,
      datasetId: viewId,
      data: isRecord(row.d) ? row.d : {},
      geometryType:
        isRecord(geom) && typeof geom["type"] === "string"
          ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the server derives it from ST_AsGeoJSON; the union is the PostGIS type set.
            (geom["type"] as EntryRow["geometryType"])
          : null,
      createdAt: "1970-01-01T00:00:00.000Z",
    };
  });
}

/**
 * The row a derived live id names (#331): `live:<row_id>` (or
 * `live:<row_id>:<occurrence>` for a repeated source row) — the map popups
 * hold nothing else, so the live executor resolves the row by walking the
 * same derivation `liveRowsToEntries` built. `undefined` = the id names a
 * row the current (capped) read no longer carries.
 */
export function liveRowByEntryId(
  rows: readonly LiveWireRow[],
  entryId: string,
): { data: Record<string, unknown> } | undefined {
  if (!entryId.startsWith("live:")) {
    return undefined;
  }
  const rest = entryId.slice("live:".length);
  const parts = rest.split(":");
  const last = parts[parts.length - 1];
  const occurrence = parts.length > 1 && /^\d+$/.test(last) ? Number(last) : 1;
  const base = occurrence === 1 ? rest : rest.slice(0, rest.length - String(occurrence).length - 1);
  let seen = 0;
  for (const row of rows) {
    const rowBase = typeof row.row_id === "string" ? row.row_id : undefined;
    if (rowBase !== base) {
      continue;
    }
    seen += 1;
    if (seen === occurrence) {
      return { data: isRecord(row.d) ? row.d : {} };
    }
  }
  return undefined;
}

function cellOf(row: EntryRow, key: string): unknown {
  return isRecord(row.data) ? row.data[key] : undefined;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const an = typeof a === "string" ? Number(a) : Number.NaN;
  const bn = typeof b === "string" ? Number(b) : Number.NaN;
  if (typeof a === "string" && typeof b === "string" && !Number.isNaN(an) && !Number.isNaN(bn)) {
    return an - bn;
  }
  return text(a).localeCompare(text(b), undefined, { numeric: true });
}

function matches(row: EntryRow, filter: SearchFilter): boolean {
  const cell = cellOf(row, filter.key);
  const value = filter.value;
  switch (filter.op) {
    case "eq":
      return JSON.stringify(cell) === JSON.stringify(value) || text(cell) === text(value);
    case "neq":
      return !(JSON.stringify(cell) === JSON.stringify(value) || text(cell) === text(value));
    case "contains":
      return text(cell).toLowerCase().includes(text(value).toLowerCase());
    case "gt":
      return compareValues(cell, value) > 0;
    case "gte":
      return compareValues(cell, value) >= 0;
    case "lt":
      return compareValues(cell, value) < 0;
    case "lte":
      return compareValues(cell, value) <= 0;
    case "in":
      return Array.isArray(value) && value.some((member) => text(member) === text(cell));
    default:
      return false;
  }
}

/** The table's `search_entries` arguments applied over a live result (one page: the cap is the bound). */
export function searchLiveEntries(
  entries: readonly EntryRow[],
  args: Pick<SearchEntriesArgs, "query" | "filters" | "sort">,
): SearchEntriesPage {
  let out = [...entries];
  const q = (args.query ?? "").trim().toLowerCase();
  if (q !== "") {
    const terms = q.split(/\s+/);
    out = out.filter((row) => {
      const haystack = JSON.stringify(row.data).toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }
  for (const filter of args.filters ?? []) {
    out = out.filter((row) => matches(row, filter));
  }
  if (args.sort !== undefined) {
    const { key, dir } = args.sort;
    out.sort((a, b) => {
      const result = compareValues(cellOf(a, key), cellOf(b, key));
      return dir === "desc" ? -result : result;
    });
  }
  return { rows: out, nextCursor: null };
}
