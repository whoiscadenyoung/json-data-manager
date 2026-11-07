---
name: project-anon-serving-0024-lessons
description: "#261 gotchas: the pmtiles:// scheme prefix on frozen tile sources, cross-port localhost cookie sessions defeat signed-out tests, policy names truncate at 63 chars, and the per-port stack split (int tests vs the app's kong :8000)"
metadata:
  type: project
---

Serving + storage-leg gotchas from anon serving (#261, migration 0024, ADR
0023 — 2026-11-07):

- **`MapVectorTiles` URLs need the `pmtiles://` scheme prefix.** A bare
  signed storage URL is not a loadable maplibre URL — the tile source loads,
  the archive reads fine over range requests, and NOTHING paints (silent).
  The live path wraps in the layer-source decision (`pmtiles://${meta.url}`);
  a hand-rolled tile source must wrap too.
- **Localhost cookies are shared across PORTS.** The compose demo app's
  prod-SSR build (kong :8000, cookie-based supabase-js storage) sets
  `sb-localhost-auth-token` for `localhost` — the :3001 dev app reads it on
  the next load, so a "signed-out" browser test silently runs signed-in.
  `localStorage` cleared ≠ signed out; delete the cookie too. This is an
  environment quirk, not an app defect.
- **The two stacks have DIFFERENT databases.** Int tests hit the CLI stack
  (`supabase_db_jdm-supabase-backend`, :54322); the app dev points at the
  compose demo stack (`jdm-db`, kong :8000). Migrations must be applied to
  BOTH by hand (`psql -U supabase_admin -d app` on compose — `postgres` is
  not the owner there), and the compose DB drifts: 0022 had been applied
  without bookkeeping, so re-running it aborts mid-file ("column already
  exists") — probe the actual state (`information_schema.columns`,
  `pg_policies`) before trusting a bookkeeping row.
- **Policy names truncate silently at 63 chars** ("...of link/public datas→
  datase") — keep them short or the pg_policies probes miss.
- **storage-api masks RLS denials as `Object not found`/`NoSuchKey`** (400
  with a 404 body), not 403 — an anon sign test that returns NoSuchKey is
  the policy working, not the object missing.
- `createSignedUrl`'s raw `signedURL` is a relative path (`/object/sign/…`)
  — supabase-js absolutizes; hand-built fetches must prepend
  `/storage/v1`.
- A one-shot worker instance is the clean way to reuse the tile builder for
  a non-scheduler job: its frozen-`*` message types never touch the live
  build-state store, and the worker's own token-handshake plumbing
  (`fetchTokenFromMain`) works unchanged.
