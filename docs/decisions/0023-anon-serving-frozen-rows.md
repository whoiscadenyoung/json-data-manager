# ADR 0023: Anon serving — frozen rows only, no live-table policies

Date: 2026-11-07 · Status: accepted · Issue: [#261](https://github.com/whoiscadenyoung/json-data-manager/issues/261) ·
Train: [project-centric umbrella #254], phase 7 · Design: `docs/project-centric-experience-design.md` §6.1, §7 D4

## Context

ADR 0022 built the ladder and wrote the anon SELECT gates on the frozen
rows (`dataset_versions`/`version_entries`/`layer_versions`/`app_versions`,
each gated through SECURITY DEFINER helpers at exactly `link`/`public`) —
but nothing served a signed-out visitor: the root `AuthGate` redirected
every anonymous visitor to `/signin`, and the published viewer's first read
(the live `apps` row) has no anon policy by design. `link` and `public`
were labels, not serving levels. The issue's scope adds the tile leg: the
frozen map widget drew inline `version_entries` only, and a naive anon
policy on the `tile-archives` bucket would leak the LIVE archives (built
from post-freeze live rows the ladder never grants anon).

## Decision

1. **The public route is exactly `/apps/$appId`.** The root `AuthGate`
   exempts one pathname shape (`/apps/<id>`, nothing deeper — `edit` and
   `preview` stay gated; the explorers stay signed-in until [project 8]).
   While the session resolves the gate still holds its spinner (SSR
   unchanged — no new server surface); once resolved signed-out, the route
   renders and its anon branch owns the view.
2. **The anon branch reads ONLY the frozen chain.** The live `apps` row and
   the membership reads don't run for a signed-out visitor (no anon
   policies — the reads would be vacuous). The HEAD `app_versions` row is
   the primary read; its self-contained snapshot (title/pages/datasetPins/
   mapSnapshots/flattened layerVersions — ADR 0021) renders the whole view.
   A null head is THE denial: non-existent id, `members`, and `signed-in`
   apps are indistinguishable (RLS-honest), shown as a card with a
   sign-in CTA that preserves the link. No service-role shortcuts; the
   anon grant IS the access model.
3. **No standalone public map route.** Maps have no frozen chain of their
   own — a map's frozen form exists only inside an app snapshot (D7).
   "Map snapshot rendering without a session" means the map widget inside
   the published app; a standalone public map URL would need a
   `map_versions` freeze mechanism and stays out of this train.
4. **Tiles serve from frozen-version archives, path-scoped.** The publish
   walk builds each large geospatial pin's PMTiles archive from EXACTLY its
   pinned version's immutable `version_entries` rows (the same builder the
   live scheduler uses, driven through a one-shot worker message) and
   stamps the pointer on the pin (`frozen_archive` in the snapshot jsonb —
   no install RPC, the live pointer is untouched). Migration 0024 grants
   anon SELECT on `tile-archives` objects matching the FROZEN path
   convention (`<datasetId>/frozen-<versionId>-<token>.pmtiles`) whose
   dataset sits at `link`/`public`. The `frozen-` marker is the leak guard:
   the LIVE archives (`v<version>-…`) stay anon-closed because their
   content can carry post-freeze edits. Below the 256 KB threshold the pin
   stamps null and the widget renders rows.
5. **The read side splits per pin.** The frozen map canvas signs a URL per
   stamped pin (anon signing works under the 0024 policy; signed-in
   consumers keep the 0004 `can_view_dataset` policy) and feeds it to the
   map as a `pmtiles://` tile source; pins without a stamp page immutable
   rows as before. A failed sign or an old-format stamp falls back to rows.

## Consequences

- A signed-out visitor opening a `link`/`public` app gets map + data +
  tiles from frozen data alone; narrowing the app to `members` closes the
  serving gate on the next anon read (the frozen rows close with it —
  ADR 0022's helpers read the LIVE rung). A `min(closure)` blocker still
  caps the share exactly as it caps the signed-in outsider: the app
  snapshot serves, the blocked member's frozen rows do not.
- Publishing grows a tile-build leg for large geospatial datasets (the
  same cost the live scheduler pays); the leg degrades to rows on any
  failure — it never fails the publish, and the dialog names the
  fallbacks.
- The `visibility` field of the anon view model is the visitor's own
  posture (`link`), not the artifact's current rung — the frozen snapshot
  cannot know it honestly. The signed-in published view reads the live row
  and shows the true rung chip.
- Live tables stay permanently closed to anon; any future consumer surface
  must ride the frozen chain or extend the definer-helper pattern (0023's
  lesson: an inline subquery in an anon policy reads zero rows forever).
