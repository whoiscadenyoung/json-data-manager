# 20. Dataset relations: catalog-level data truth + the bounded relation-aware map runtime

- Status: accepted
- Date: 2026-11-06
- Phase 4 of the [project-centric experience train](../../project-centric-experience-design.md)
  (§4.2 relations, §5 the walkthrough, §7 D3; issue #258, umbrella #254).
  Builds on [ADR 0017](0017-project-membership-roles.md) (roles gate every
  write), [ADR 0018](0018-project-catalog-owned-vs-linked.md) (owned vs
  linked) and [ADR 0019](0019-layers-project-owned-maps.md) (layers → maps).
  Migration `0021_dataset_relations.sql` carries the schema + the runtime RPC.

## Context

The GIS+BI payoff moment is the click: a polygon lights up its related
points, and the popup shows the joined records (ArcGIS related-record
popups; Power BI cross-highlight). The fact "parks points live within park
polygons" is DATA truth — it must be declared once, where the data lives,
not per map or per app ([D3](../../project-centric-experience-design.md)):
presentations consume relations; they never own them.

## Decision

- **`dataset_relations` is a catalog-level row, project-free** (D3, the
  relationship-classes / PBI-model posture): `from_dataset`/`to_dataset` →
  `datasets`, `kind 'key'|'spatial'`, `cardinality '1-1'|'1-N'|'N-M'`,
  `config` jsonb, `unique (from, to, kind)`. The creation UX lives in the
  project catalog ("Relate datasets" — the working context), but the row is
  reusable by every project holding both datasets as members. The reverse
  pair is a distinct row (a legitimately different declaration).
- **Direction semantics**: the spatial predicate always reads
  subject-against-object; `direction 'forward'` makes the FROM side the
  subject, `'reverse'` the TO side — so `{within, forward}` and
  `{contains, reverse}` are the same fact phrased twice (and, being the same
  ordered pair + kind, only one can exist). At query time every combo
  reduces to `ST_Within`/`ST_Intersects` over (clicked, other):
  other-first ⇔ `(predicate = 'within') = other_is_subject`.
  Cardinality is the popup's declared shaping (1-1 inlines, lists
  otherwise) — the query always answers with what the data says.
- **Visibility/writes ride the datasets' own gates**: SELECT requires
  `can_view_dataset` on BOTH ends (seeing one end never leaks the other);
  INSERT/UPDATE/DELETE require `can_edit_dataset` on both. A project seat
  grants nothing the data forbids — a viewer of a project cannot declare a
  relation over a locked dataset, and an editor of an open dataset can,
  regardless of seats.
- **Ends are datasets only.** Derived datasets are virtual rows computed
  from specs; they have nothing material to relate against until the
  stage-5 seam lands. In the map runtime a derived layer's click resolves
  through its SOURCE dataset.
- **The runtime RPC `dataset_relation_records` is bounded by construction**
  (the 2026-10 map-perf lesson): SECURITY INVOKER (every read rides the
  caller's RLS), index-backed predicates (entries GIN containment for key;
  `geometries_geom_gist` `&&` for spatial), viewport-scoped (the caller's
  click-time bbox), server-capped (default 200, hard 500), offset paging
  for the popup's "show more", deterministic order (`entries.id` /
  `version_entries.ordinal`). One plpgsql function branches on kind; the
  page cut is the innermost query level (windows evaluate before
  offset/limit — an `rn` beside the cut would number the global order and
  empty every page after the first).
- **Pinned members resolve through their pinned versions** (the
  relations-survive-sync rule): the OTHER side's membership in the consuming
  project (`consumer_references`, 0009) decides live-vs-frozen — a pin
  answers from the `version_entries` of the pinned version even after the
  source republishes; owned/floating/non-member sides answer live. The
  CLICKED side is always live this phase (rendering is live until
  [project 5]'s frozen-row work, ADR 0019).
- **The runtime mounts opt-in** via `LayersMap`'s `relationRuntime` prop —
  the in-project editor passes it; surfaces without it pay zero reads and
  keep plain popups. The highlight overlay is amber, drawn on top of the
  schema layers, and clicking a highlighted point drills in. No realtime
  publication join for `dataset_relations`: relations are consumed at click
  time (a fresh query per click can't go stale) and declared in the catalog
  (TanStack invalidation covers same-tab).
- **Key relations carry the one-click lookup-join offer** ("Join into a
  table"): the declaration and the transform engine's lookup op are the
  same fact, two consumers — the offer materializes a saved derived
  dataset (left-join by the relation's own key fields) without opening the
  builder.

## Consequences

- The acceptance scenario works end-to-end: declare `points within parks`
  once in the catalog; any project's map holding both datasets highlights
  related features and lists related records bounded at ~200 with "show
  more"; pinning the points dataset freezes the popup's answer against
  source republishes until a member syncs.
- Relation ends are only as writable as the data: declaring over open
  datasets is any-member; over locked ones, creator-only. The catalog
  section surfaces relations declared anywhere the viewer can see both ends.
- Frozen-side spatial resolution walks the pinned version's `bbox`
  envelope prefilter + per-row GeoJSON parse — no GiST exists on
  `version_entries` (frozen rows are immutable by construction); bounded by
  the version's size and the viewport prefilter. Storage-backed frozen rows
  (geometry null) are skipped, as in `publish_version`.
- Migration gotchas met live (repo memory:
  `docs/memory/project-relations-0021-lessons.md`): the 0009 stamp trigger
  makes `created_by := auth.uid()` NULL in migration sessions — 0020's
  per-creator map backfill now asserts the creator's identity GUCs per
  iteration (met on the compose demo stack's legacy data; CI's fresh
  databases never see it), and row-local CHECK constraints must
  COALESCE-guard jsonb key probes (`jsonb_typeof(missing) = 'string'` is
  NULL, and a NULL check passes vacuously).
