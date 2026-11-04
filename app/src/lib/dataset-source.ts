/**
 * The transitional split's key (design doc §14): from stage 1 a dataset is
 * served by the backend it was CREATED on, and both backends are live — the
 * new Postgres-native datasets ride `#/lib/store/*` while every pre-migration
 * Convex dataset keeps rendering through its existing Convex surface, never
 * edited by the new code.
 *
 * The two id spaces are disjoint, so the id IS the creation record: Postgres
 * rows carry `gen_random_uuid()` values (dashed uuids, §3.2), and Convex
 * document ids are 32-char lowercase base32-ish strings that never contain
 * a dash. `isPostgresDatasetId` is the one place that reads the split, so
 * every surface branches on the same explicit predicate instead of re-deriving
 * its own heuristic.
 */

const POSTGRES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `id` was minted by the Postgres backend (a uuid) — false for every Convex dataset id, which has no dashes. */
export function isPostgresDatasetId(id: string): boolean {
  return POSTGRES_UUID.test(id);
}
