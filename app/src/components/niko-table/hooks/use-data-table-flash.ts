import type { FlashCells, FlashRows } from "../core/data-table-context";
import { useDataTable } from "../core/data-table-context";

/**
 * Briefly highlight what just changed. `flashRows([id])` for a record-level
 * change (record-level — e.g. a member added to a game); `flashCells([{rowId,
 * columnId}])` for value-level changes (cell-level — e.g. a grid edit/paste).
 * Both scroll the first target into view (on virtualized bodies) then play a
 * soft fade pulse. Works on read tables and the editable grid alike.
 *
 * Throws outside a `DataTableRoot` (inherited from `useDataTable`).
 *
 * @example
 * const { flashRows, flashCells } = useDataTableFlash();
 * flashRows([updatedGameId]);                        // whole record changed
 * flashCells([{ rowId, columnId: "email" }]);        // one value changed
 */
export function useDataTableFlash(): {
  flashRows: FlashRows;
  flashCells: FlashCells;
} {
  const { flashRows, flashCells } = useDataTable();
  return { flashRows, flashCells };
}
