# 10. Dataset edit policy: `editPolicy: "open" | "locked"` — locked datasets are creator-only

- Status: accepted
- Date: 2026-10-01
- Supersedes the co-editable clause of [ADR 0009](./0009-trusted-collaborator-catalog.md)
  **for `editPolicy: "locked"` datasets only**; every other clause of ADR
  0009 (trusted collaborators, shared maps/collections/groups, absolute
  read-only guarantees, signup gating) stands unchanged.

## Context

ADR 0009 closed the 2026-09-30 review's write-ownership findings as _by
design_: any signed-in user can update, clear, delete, or import into an
ordinary published dataset. That is the right default for a shared catalog,
but it left a dataset's creator no way to keep writing to themselves — the
gap [#124](https://github.com/whoiscadenyoung/json-data-manager/issues/124)
was filed to close, with the building blocks already in place: the `auth()`
choke point (ADR 0007), `schemas.createdBy`, and the per-function `fn` on
`ExposeApiOperation`.

## Decision

- **One new field on the component's `schemas` row: `editPolicy:
"open" | "locked"`.** `"open"` — and ABSENT, so every pre-field row — is
  refused nowhere: today's co-editable behavior, no migration. A literal
  union (not a boolean) so the recorded growth path — a later
  `{ mode: "team", teamId }` — extends additively, the way `lifecycle` grew.
- **`"locked"` means only the creator can write — every write.** Data
  writes (entries, bulk, clear, imports), schema writes (update, delete),
  the transform runs (simplify, geospatial conversion), and the organization
  ops the read-only gate deliberately allows (collection/group membership):
  on a locked dataset the creator-only rule covers them all, with no
  carve-outs.
- **Reads never consult the policy.** `publishedVisibility` decides who may
  READ a dataset; `editPolicy` decides who may WRITE it. The two compose
  into the four combinations (public+open, public+locked, private+open,
  private+locked); visibility stays the authoring-time choice it was in
  stage 8.
- **Enforcement lives in the host's `auth()` choke point** (the component
  stays auth-less): after the visibility check — an invisible row still
  reads as "not found", never as "locked" — and before the bound/frozen
  read-only gate, which the policy never relaxes. The denial is a plain
  read-only-shaped `ConvexError`; existence of a published row is already
  public, so a lock denial leaks nothing.
- **Host flows that bypass the wrappers carry the check explicitly** via
  `assertDatasetWritable` (`app/convex/auth.ts`): `bindings.unbind`
  (unbinding deletes the dataset), `bundles.recordMember` (the one place a
  press accepts a client-supplied component row id) and
  `bundles.promoteCollection` (filing referenced members), closing the
  client-supplied-`publishedSchemaId` bypass for locked rows. Open rows keep
  the whole shared-catalog press flow byte-for-byte.
- **The tag path's existing creator rules already answer only to the
  creator for every row a policy could lock** (`tags.retireVersion`'s
  defined-creator check; `assertChainAnchorWritable` behind
  `setVersionPinned`/`setKeepVersions`) — their recorded denial shapes
  ("Version dataset not found.", the gone-reference answer) are unchanged,
  and explicit `assertDatasetWritable` calls ride after them as
  defense-in-depth on the surfaces the issue names. `tile_archives.install`
  needs nothing new: its `{fn, schemaId, "update"}` operation already flows
  through the choke point.
- **The control is `schemas.setEditPolicy`, creator-only** — the
  `setVisibility` twin (component mutation public-in-component but
  unexposed; the host resolves identity and enforces ownership; denials read
  as "not found"). Locking is itself a write the policy gates, so only the
  creator can flip it either way; the mutation deliberately carries no
  operation into `auth()`, because the flip must predate the policy it
  changes.
- **Maps stay open.** Maps, collections, and groups remain shared catalog
  artifacts (the ADR 0009 clause stands for them). What #124 ships is the
  seam: `ExposeApiOperation.mapId` is now carried by EVERY map and
  layer-targeted mutation — the four layer-by-`layerId` wrappers resolve
  their row's map through the host-flow-only `getMapLayerMapId` read (the
  `getImportSchemaId` pattern) — so a per-map policy is later an additive
  predicate in `auth()`, not a wrapper reshuffle.
- **Frozen versions and bound datasets stay read-only whatever the policy
  is.** The edit policy adds a restriction for locked rows; it never removes
  the component-level `boundWrite` guarantees (ADR 0009's absolute clause).

## Consequences

- Creators get a real private-working surface: lock a published dataset and
  co-editing stops at their id, while everyone signed in can still read,
  export, and layer it. The UI says so everywhere — a Locked badge on cards
  and the dataset page, the creator's Lock/Unlock control beside the
  visibility control, and disabled write actions carrying the reason (never
  a silent no-op).
- "Authz findings about co-editing are closed as by design" now needs the
  qualifier: by design **unless the dataset is locked**. Agents must not add
  per-user write restrictions beyond `editPolicy` — the field and its
  creator rule are the whole mechanism.
- Trust still rests on controlled sign-in (#136): a locked dataset's
  creator-only rule assumes identities are real.
- Teams later: `"team"` would extend the union and need a team resolution
  surface; nothing in the field, the enforcement shape, or the UI contract
  changes first.
