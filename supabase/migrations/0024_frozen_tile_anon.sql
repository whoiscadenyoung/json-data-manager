-- Anon tile serving: frozen-convention tile archives of link/public datasets
-- (issue #261 — the project-centric train, phase 7;
-- docs/project-centric-experience-design.md §6.1; ADR 0023).
--
-- The serving model (the "frozen rows only" decision, now including tiles):
--   * The published app's map widget draws its pinned dataset versions.
--     Since #259 it drew them as inline `version_entries` rows; #261 lets
--     the publish walk ALSO build a PMTiles archive from exactly those
--     frozen rows and stamp the pointer on the pin (`frozen_archive` in the
--     snapshot's datasetPins jsonb). The archive's content is the pinned
--     version's data by construction — never the live rows.
--   * This migration is the storage leg: `to anon` SELECT on the
--     `tile-archives` bucket objects whose path carries the FROZEN
--     convention — `tile-archives/<datasetId>/frozen-<versionId>-<token>.
--     pmtiles` — gated on the first segment's dataset sitting at
--     `link`/`public` (the 0023 definer helper; an inline subquery in an
--     anon policy would read zero rows — the 0023 lesson).
--   * The leak guard is the path convention: LIVE dataset archives upload to
--     `<datasetId>/v<version>-<token>.pmtiles` (built from the live rows at
--     the dataset's current cache version — content the ladder never grants
--     anon, since it can carry post-freeze edits). The second segment's
--     `frozen-` marker is what anon policy matches; live objects fail it
--     closed. Every other shape fails closed too (the 0004 helper returns
--     null for a non-uuid first segment).
--   * Writes need nothing new: the publisher uploads through the existing
--     authenticated policy (`can_edit_dataset` on the path's dataset), and
--     signed-in consumers keep reading through the 0004 select policy
--     (`can_view_dataset`). Only the anon rung is new.

do $do$
begin
  if to_regclass('storage.objects') is null then
    raise notice '0024: storage tables absent (no storage-api service in this environment) — anon tile policy skipped';
  else
  drop policy if exists "tile-archives: anon reads frozen link/public archives"
    on storage.objects;

  create policy "tile-archives: anon reads frozen link/public archives"
    on storage.objects for select to anon
    using (
      bucket_id = 'tile-archives'
      and split_part(name, '/', 2) ~ '^frozen-'
      and public.published_dataset_anon_visible(public.dataset_id_of_storage_path(name))
    );
  end if;
end
$do$;
