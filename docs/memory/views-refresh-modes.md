---
name: views-refresh-modes
description: "#305 gotchas — auto refresh (data_version trigger -> view_refresh_queue -> app-server drain as the editor who enabled auto), live views (capped server read, no tiles), runner-only mode switch, nitro plugin registration, base-ui Select in jsdom"
metadata:
  type: project
---

2026-11-10, #305 (migration `0029_views_refresh.sql`, `app/src/server/views/refresh.ts`).

- **Auto is NOT pg_cron.** pg_cron exists (0012) but runs SQL only; a view run
  needs the TS compiler. Trigger on `datasets` `AFTER UPDATE OF data_version`
  enqueues `view_refresh_queue` (one row per view); the app server drains it
  (`startRefreshLoop`, Nitro plugin `server/views/refresh-plugin.ts`, registered
  via `nitro({ plugins })` in `vite.config.ts`; a no-op without `DATABASE_URL`;
  `VIEW_REFRESH_POLL_MS=0` disables). Window = fixed 60 s from the first change
  (coalescing, not trailing debounce); `jdm.view_refresh_debounce_seconds`
  overrides it. Tests make a row due with `update ... set due_at`.
- **Identity** = `datasets.auto_refresh_by` (the editor who set Auto). The drain
  builds claims for that stored id (`identityClaims`), so RLS and
  `can_edit_dataset` apply. A revoked identity fails at the gate, which the
  normal `view_record_failure` refuses too (it needs edit rights), hence the
  separate `view_refresh_record_failure`.
- **Single flight** = the claimed queue row (`claimed_at`); a change during a run
  sets `redo_at` and `view_refresh_finish` re-queues once. Claims older than 15
  min are reclaimed.
- **Only `set_view_refresh_mode` (view_runner-only) moves a view to auto/live.**
  `create_view` / `save_view` now raise for anything but manual (they used to take
  any mode). The spatial refusal lives in TS, so it must not be bypassable.
- **Live saves nothing**, so `is_geospatial`, `properties` and `geometry_type` would
  stay empty and the map/table would not treat the view as geospatial: an
  editor's live read mirrors them with `view_sync_live_meta` (also done right after
  switching to live). `view_stale` is false for live.
- **The tile watch feed excludes live views** (`refresh_mode is null or neq live`);
  a live view still has snapshot rows after an export, which would otherwise
  schedule an archive. The map's loader asks `liveDatasetIdsQueryOptions` first
  and renders `PgLiveGeometriesLoader` for them (loaders wait for that answer).
- **Known gap:** map popups look entries up by id in the DB; live rows have
  derived ids (`live:<row_id>`) that exist nowhere, so popups over a live layer
  have no entry details. Table search/sort/filter run client-side over the capped
  result.
- **Test notes:** base-ui `Select` in jsdom opens on pointerdown/mousedown on the
  trigger, and an option is chosen with focus + keyDown Enter + click (a plain
  click does nothing). Int test for the whole feature:
  `src/lib/store/pg-views-refresh.int.test.ts`. Measurement script:
  `app/scripts/measure-live.ts` (numbers in views-design §7).

Related: [[views-initiative]], [[views-server-runner]], [[int-test-db-split-ri-teardown]].
