# Catalog lifecycle — projects, publish, and versioned consumption

Design for the draft → publish lifecycle over the dataset catalog: **projects**
as the virtual working layer where imports, transforms, and maps are drafted;
**publish** as the act of materializing and freezing artifacts into the
catalog; **versions** as the notify/diff/sync/revert contract with consumers.
Companion to [`derived-datasets-design.md`](./derived-datasets-design.md)
(the transformation engine) — this doc supersedes that doc's §9 Projects
deferral and its §11 virtual-materialization lean; see
[ADR 0008](./decisions/0008-catalog-lifecycle.md). Captured 2026-09-21;
**design only, nothing implemented**, and implementation stays staged behind
the derived-datasets engine (§9).

## 1. Context and goal

Two concrete scenarios drive the model:

- **SMART grants.** Import a year's SMART grant data into a project, put all
  of that year's datasets on one map with layer groups (IG points group, IG
  polygons group, an Action Plan group with its own polygons and point
  layer), and publish — the map *and* its underlying datasets. One project
  per year (SMART 2024, SMART 2025, …), each publishing as a bundle.
- **Restaurant join.** Pull the published restaurants, locations, and
  restaurantLocations datasets into a project, join them, and produce one
  flattened dataset where each restaurant-location is a point carrying
  restaurant name and location data. Whether the underlying sources are
  exposed is deliberately undecided — the model should not force it.

Standing requirements: the published layer **must remain the existing
performance-optimized design** (entries/geometries, `boundingBox`, byte-budget
pagination, tile archives, on-demand popups); imported/underlying data is
never mutated; working state must survive a crashed machine or browser.

## 2. Decisions recorded

- **Projects are virtual; the catalog is materialized; publish is the
  crossing.** Inside a project everything is drafts and specs — imports plus
  transform specs computed client-side (the execution model of ADR 0005),
  map previews rendered from client-side compute. Publish writes real,
  ordinary datasets into the catalog.
- **Publish materializes and freezes.** An imported dataset publishes as a
  version dataset (a frozen state — it already is rows). A derived dataset
  publishes by *executing its spec once* into a version dataset carrying
  lineage (recipe + source versions). This supersedes the earlier
  "publish registers the virtual spec" lean: virtual artifacts would have to
  be pushed through the entire materialized perf stack (archives, extents,
  pagination), and materialization is what decouples source exposure (§5.2).
- **The catalog is append-only.** Republish creates a new immutable version;
  forks never merge back into their sources. The catalog holds frozen states;
  the project holds the live recipe (*tags materialize; commits don't* — the
  bound-datasets principle, applied to ourselves).
- **Consumption is pin/float with diff, sync, revert.** Consumers reference a
  version (pin) or head (float). New versions notify in-app (badge on every
  consuming artifact + a consumed-by list), consumers diff via the version
  delta (the `tagDeltas`/compare machinery), sync advances the pin (derived:
  re-run the spec and re-freeze), revert repins. Generalizes the
  frozen-version machinery already shipped for bound datasets (lineage
  fields, pinning, keep-N retention) — no new versioning system.
- **Auto-publish dependencies.** Publishing an artifact promotes what it
  references *live*: a published map forces its layer datasets to publish; a
  materialized derived dataset references nothing live and therefore forces
  nothing.
- **Exposure is decoupled from function.** Because published derived
  datasets are self-contained, sources stay private in the project unless
  separately published. "Expose underlying data?" is a per-artifact choice,
  never a side effect.
- **Bundle rule: one project = one publishable bundle** — its collection
  plus its maps plus the datasets they reference (SMART 2024, not "all
  SMART"). Keeps publish a single comprehensible act.
- **Concept mapping.** Datasets: atomic artifacts, versioned once published.
  Collections: promoted to publish bundles (the published form of a project);
  many-to-many with datasets preserved. Groups: demoted to display folders —
  they never participate in the lifecycle and gain no new responsibilities.
  Maps: artifacts in both layers; layer-group structure already persists
  (saved map views), so publishing a map is promotion, not restructure.
- **Auth gating is the prerequisite for the multi-user stages.** Better Auth
  and per-creator attribution (`schemas.createdBy`) have landed; per-user
  projects, sharing, and the fork loop wait on data access being gated on
  sign-in.
- **Drafts are durable by construction.** Everything in a project is a
  Convex document; the durability rule is *save early* (§6).

## 3. State model

`draft (in a project) → published (catalog, v1) → republish (vN+1) …`

- Drafts are invisible to catalog consumers; the datasets browser becomes
  the catalog (published by default, a toggle for drafts), and the project
  browser shows the working layer.
- Import/create lands **in a project** — the project is part of the
  import/create flow, not a separate act. (Until projects ship, staged
  authoring happens directly in the catalog per ADR 0005 §10; projects then
  become the authoring surface.)
- **Fork = add-to-project**: reuse-as-is adds a reference; reuse-with-
  transforms creates a derived spec over the published source. No copies.
- Republish never merges back; a fork's new version is its own lineage line.

## 4. The virtual/materialized line

| | In a project (draft) | Published (catalog) |
| --- | --- | --- |
| Rows | Real (imports write entries) or spec-computed client-side | Materialized entries/geometries, frozen per version |
| Maps | Preview from client-side compute | Existing row/tile path, #52 on-demand popups |
| Perf machinery | None committed — no `boundingBox`, no archives | All of it, unchanged |
| Consumers | The author only | Everyone; pin/float + sync/revert |

Nothing in the published layer knows projects exist. A published map,
collection, or dataset is shaped exactly like today's artifacts, so every
existing surface (maps workspace, dataset pages, exports, archives, popups)
works on day one of the lifecycle; the entire change lives on the draft side
of the line.

## 5. Worked scenarios

### 5.1 SMART <year>

Import the year's datasets → arrange one map with layer groups (exists
today: nested layer-group visibility with per-child eye toggles) → publish
the project. Auto-publish promotes the map's layer datasets; the bundle is
**collection SMART 2024 + map SMART 2024 + published datasets**, each frozen
as v1. Sources are exposed naturally — they are imports, and exposure is the
point. Next year is a sibling project.

### 5.2 Restaurant join

Add the three published datasets to a project → build the join
(restaurantLocations enriched with locations fields and restaurants fields) →
preview on an in-project map (points render client-side) → publish. The
published artifact is **one flattened point dataset**; the three sources can
stay private, with lineage metadata recording the recipe. When a source
republishes, the project shows "sources changed" → re-run the spec → new
frozen version → consumers get the notify/diff/sync/revert flow.

**New spec wrinkle: `geometrySource`.** The join table has no coordinates —
the point geometry comes from the *locations* side of the join. A transform
spec therefore needs a geometry rule ("geometry from the locations lookup
side"); at materialization the derived version's entries get geometryIds
from the joined rows. Small spec addition, named here because it is the one
genuinely new requirement the scenarios surfaced.

## 6. Durability and crash resilience

A crashed machine must never lose meaningful work. The model gets most of
this for free because **drafts are server-side documents**:

- Imports already land incrementally (chunked upload pipeline) — a crash
  mid-import leaves resumable, partial state, not loss.
- Transform specs are documents: the builder **saves a draft on edit**, not
  only at publish. Same for map/layer arrangement (saved map views already
  persist live).
- The only volatile state is unsaved builder UI; the design rule is
  *autosave early and often* so a reload reconstructs the project.
- Long-running publishes must **checkpoint and resume** like the durable
  sync engine (`syncRuns`: chunked collect/apply, keyed idempotency, resume
  exactly). Materialization reuses the existing ingest machinery for its
  writes (extents, archive-rebuild triggers, retention).

## 7. Versioning, notify, sync, revert

- Every published dataset — imported or derived — is a version chain:
  v1, v2, … with lineage ("imported from file X" / "derived via recipe R
  over sources at v2, v1").
- Notification is in-app only (no email/push infra): a "source published
  v2" badge on each consuming artifact (the `sourceUpdatedAt` binding-badge
  pattern) and a consumed-by list per dataset.
- Sync: repin (reference) or re-run + re-freeze (derived). Revert: repin.
- Diff: the version-delta compare (existing `tagDeltas` machinery).
- Retention: keep-N with pinning, as shipped for frozen tag versions.

## 8. Prerequisites and staging

The lifecycle changes *what* gets built late, not *what* gets built first:

1. Transform engine + registry/preview + surfacing — ADR 0005 §10, unchanged.
2. **Materialized publish** — execute spec → write via the existing ingest
   path (checkpointed per §6). The main engineering weight of the lifecycle.
3. **Version sync/revert UX** — badges, diffs, pin/float on published
   datasets.
4. **Projects, fork, sharing** — after auth gating (Better Auth follow-up)
   lands; groups/collections schema stays as-is throughout, with collections
   taking the publish-bundle role and groups freezing feature-wise.

## 9. Open questions

- Popup executor for *project* previews (index table vs. client key map) —
  unchanged from the companion doc §11; published maps use the existing #52
  path on materialized rows.
- Composite (multi-column) join keys — unchanged.
- Sharing granularity (per-user vs. per-team projects) — decided when auth
  gating lands.
- Version-chain growth policy for frequently republished datasets (keep-N
  defaults; confirm per-artifact).
- Whether published collections pin exact dataset versions or float on head
  (lean: float with a "changed" badge, since versions are cheap to repin).
- Analytics over draft/published data (a DuckDB-style SQL layer) is designed
  separately — [`analysis-layer-design.md`](./analysis-layer-design.md);
  its row-resolution and typed-structure invariants constrain the seams in
  this design.
