import type { GeometryTypeArg } from "../../shared/geojson/validators.js";
import type { Id } from "../_generated/dataModel.js";
import type { QueryCtx } from "../_generated/server.js";
import { parseCreationTimeCursor } from "./geometryPages.js";

/** One `entries` row, as read directly off `ctx.db`. */
export interface EntryDbRow {
  _creationTime: number;
  _id: Id<"entries">;
  data: unknown;
  geometryId?: Id<"geometries">;
  geometryType?: GeometryTypeArg;
  schemaId: Id<"schemas">;
}

/**
 * Manual cursor-based pagination over one schema's `entries` rows — the same
 * hand-rolled approach as `paginateGeometriesBySchema` (components can't call
 * `.paginate()`), sized for entries instead of geometries. `order` selects
 * oldest-first (the conversion workflow's resume order) or newest-first
 * (`listEntriesPage`, matching the pre-pagination table); the cursor is the
 * last-returned row's `_creationTime` either way, resumed against the same
 * index range's trailing sort key.
 */
export async function paginateEntriesBySchema(
  ctx: QueryCtx,
  schemaId: Id<"schemas">,
  cursor: string | null,
  limit: number,
  order: "asc" | "desc" = "asc",
): Promise<{ continueCursor: string; isDone: boolean; page: EntryDbRow[] }> {
  const atCreationTime = parseCreationTimeCursor(cursor);

  const page = await ctx.db
    .query("entries")
    .withIndex("by_schema", (q) => {
      if (atCreationTime === undefined) {
        return q.eq("schemaId", schemaId);
      }
      return order === "desc"
        ? q.eq("schemaId", schemaId).lt("_creationTime", atCreationTime)
        : q.eq("schemaId", schemaId).gt("_creationTime", atCreationTime);
    })
    .order(order)
    .take(limit);

  const lastRow = page[page.length - 1];
  return {
    continueCursor: lastRow === undefined ? (cursor ?? "") : String(lastRow._creationTime),
    isDone: page.length < limit,
    page,
  };
}
