/**
 * True when a bound dataset's connected source changed after its last sync
 * (`sourceUpdatedAt` is stamped by every source-table write, `lastSyncedAt`
 * by each sync). Shared by the dashboard's sync card and the dataset page's
 * staleness badge / Source row.
 */
export function isSyncStale(binding: { lastSyncedAt?: number; sourceUpdatedAt?: number }): boolean {
  return (
    binding.sourceUpdatedAt !== undefined &&
    (binding.lastSyncedAt === undefined || binding.sourceUpdatedAt > binding.lastSyncedAt)
  );
}
