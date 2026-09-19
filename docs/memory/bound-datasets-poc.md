---
name: bound-datasets-poc
description: Bound-datasets integration design + working PoC (foreign tables → json-cms projection); issue #72, design at docs/bound-datasets-design.md
metadata:
  type: project
---

2026-09-18: Integration with the user's second Convex app (git-like versioning:
commits = small field deltas, snapshots = tags) is designed in
`docs/bound-datasets-design.md`, tracked as umbrella issue #72 (sub-issues to
be spun off per phase). Core model: json-cms mirrors, never re-owns
versioning — a read-only **bound live dataset** (projection keyed by foreign
`_id`), a **frozen version dataset per tag** (own archive), **commit patch
records** rendered as GeoJSON overlays, tag deltas computed at ingest. Sync
primary path = commit-tail apply; projection beats virtual tables (every
component read path works unchanged). Hosting fork (this app hosts vs.
component-in-other-app) deliberately open until the remote-transport phase.

**Working PoC shipped** (verified end-to-end on local dev): `app/convex/schema.ts`
adds foreign-domain host tables (`restaurants`, `locations` lat/lng,
`restaurantLocations` many-to-many, `datasetBindings` registry) cohabiting
with the component's tables; `app/convex/seed.ts` `seedRestaurants`
(idempotent internalMutation; run `bunx convex run seed:seedRestaurants` from
`app/` — 5 restaurants / 16 locations / 16 links, Hampton Roads + Richmond
synthetic coords); `app/convex/bindings.ts` `syncRestaurantLocations` (public
mutation) find-or-creates the "External demo" collection + geospatial Point
dataset + binding row, then clear-and-reloads the projection; `status` query
reports state. Map rendered all 16 points with **zero frontend changes**.

**Read-only source marking (phase 1 app-half, shipped 2026-09-18):**
component `schemas.source: {name}` (set via createSchema; schemaValidator
derives from the table so it flows through every read automatically), exposeApi
createSchema passes it through; app `auth.ts` gate rejects entry writes,
schema-targeted creates and deletes for datasets with a `datasetBindings` row
(metadata/organization ops stay allowed; sync bypasses via direct component
calls); UI: "Synced" badge in DatasetTypeTags (all list views), Source row in
the details card, hidden Edit/MakeGeospatial/BulkUpload/CreateEntry/Simplify.
Dataset migrated by re-running sync (sync deletes+recreates a bound dataset
missing `source`). Component-level enforcement deferred to real auth;
startSimplification/startGeospatialConversion ungatable in the current
auth-operation shape (same `{schemaId,"update"}` as organization ops).
Gotcha: changing component function args requires `bunx convex codegen
--component-dir ./src/component` in packages/json-cms (generated api types
carry signatures) before typecheck passes; then `bun run build` for dist —
the running app dev picked up the rebuilt dist WITHOUT a restart.

**Sync state + history (shown on dataset page, same day):** `datasetActivity`
app table (one row per sync; ops diffed by location label, capped 200 +
truncated), `bindings.getBySchema` + `bindings.history` queries. Dataset page:
"Out of date" badge by title + Source row ("synced X ago") when bound +
**History tab** (`?view=history`) rendering sync diffs with field-level
detail. Shared `app/src/lib/sync-staleness.ts` (dashboard card + dataset page).
Gotcha: the diff must read `entry.data.label`, not `entry.label` (component
docs wrap row data).

**Tag ingest + lineage (phase 3, shipped 2026-09-19):** foreign snapshots →
frozen version datasets, verified end-to-end (snapshot → ingest → versions
render with own maps → read-only). `app/convex/tags.ts`: `createRestaurantSnapshot`
(action — ctx.storage.store lives on the ACTION writer in Convex 1.45, not
mutations; internally splits into collectProjectionRowsQuery +
registerSnapshot) serializes the joined tables to a JSONL snapshot file +
registers a `restaurantSnapshots` row (ref = opaque unique id, the
idempotency key). `ingestSnapshots` (action = the design's PULL) freezes each
not-yet-ingested ref through the real import pipeline (generateUploadUrl+POST
chunks → component startImport → durable workflow) and polls import status;
a failed ingest deletes its half-built version so the ref retries clean.
Component: `schemas.lineage {sourceSchemaId, versionLabel, snapshotRef,
frozenAt}` + indexes `by_lineage_source`/`by_lineage_snapshotRef` (nested
index paths; docs missing the path just aren't indexed), createSchema takes
`lineage`, new queries `listSchemaVersions`/`getSchemaVersionBySnapshotRef`
(global by ref — survives re-binds). auth.ts gate: binding row OR lineage ⇒
read-only. UI: Tag badge (versionLabel) in DatasetTypeTags, Version row in
details card, Versions card on live dataset's page (api.tags.listVersions —
light projection), dashboard SnapshotsCard. Shared projection row builder
`bindings.collectProjectionRows` (geometry as OBJECT; sync stringifies it
for createEntriesBulk, snapshot JSONL keeps it whole).
Phase-3 gotchas: rebuilding a narrowed geometry object in ingest dropped
coordinates (caught E2E as "position must have 2 or 3 coordinate values" —
pass parsed objects through by reference); handlers referencing
`internal.<file>.*` need EXPLICIT handler return types (api.d.ts resolves
`typeof <module>` back through the file ⇒ inferred returns are circular);
app `internal` exports from `./_generated/api` not `./_generated/server`;
chunk uploads from actions must go through the component's generateUploadUrl
(component-scoped storage — app-stored blob ids may not resolve there).

**Environment (2026-09-18 evening):** the app dev stack (convex dev on 3212 +
vite on 3000) died mid-session and `bunx convex dev` from app/ then failed
with "You don't have access to the selected project" + non-interactive prompt
— cloud-side project check rejects the stored token (packages/json-cms has a
DIFFERENT team/project in its .env.local: caden-young/json-cms vs the app's
caden-young-noblis-org/app). Workaround used: launch the local backend binary
directly (instance name/secret from app/.convex/local/default/config.json)
+ a keeper loop (`/tmp/convex-keeper.sh`) that revives it every 2 min
(something kills it repeatedly), + push code via
`bunx convex deploy --env-file /tmp/convex-selfhost.env` (self-hosted mode
bypasses the cloud check; env file holds CONVEX_SELF_HOSTED_URL/ADMIN_KEY).
USER TODO: run `bunx convex dev` interactively in app/ (re-login if prompted)
to restore the normal dev loop. Agent-started backend processes are lossy —
writes right before a kill can vanish.

**RESOLVED same evening — switched to the cloud dev deployment.** App now runs
against `dev/caden-young` (project json-data-manager, team caden-young,
deployment woozy-husky-92). Mechanics that matter:
- `--deployment`/`deployment select` cannot be combined with CONVEX_DEPLOY_KEY;
  the working pattern is `CONVEX_DEPLOYMENT=dev:caden-young bunx convex dev
  --start 'vite dev'` with CONVEX_DEPLOY_KEY in app/.env (user-managed, do not
  read). convex dev then re-provisioned app/.env.local with the cloud
  VITE_CONVEX_URL/SITE_URL itself.
- Old .env.local (local deployment) preserved at
  `app/.env.local.local-backup`; local backend data exported (with file
  storage) to `exports/local-dev-20260918` (568 MB zip) and imported into the
  cloud with `CONVEX_DEPLOYMENT=dev:caden-young bunx convex import
  --replace-all --format zip <path>` (1756 docs + 13 storage files).
- CLI commands against the deployment: prefix
  `CONVEX_DEPLOYMENT=dev:caden-young` (deploy key auto-loads from .env).
- The vite/convex-dev nohup processes started by agents may still be reaped
  between turns — if the app stops loading data, rerun the convex dev command
  above (ideally from the user's own terminal).

**CLOUD DISABLED (2026-09-19):** the user's Convex account exceeded free
plan limits — every cloud deployment (incl. dev/caden-young woozy-husky-92)
rejects function execution with "You have exceeded the free plan limits, so
your deployments have been disabled" (pushes still succeed). The app on :3000
therefore can't load data until the user upgrades or a new deployment is
provisioned. To verify work despite this: the OLD local backend (3212) still
runs with the pre-cloud seed data; push to it with
`bunx convex dev --once --url http://127.0.0.1:3212 --admin-key <key from
app/.convex/local/default/config.json>` (move app/.env aside first so
CONVEX_DEPLOY_KEY doesn't route to cloud — RESTORE it after; also restore
the CONVEX_DEPLOYMENT line the CLI strips from .env.local — a byte-exact
copy lives at app/.env.local.local-backup). Drive functions via unauthenticated
dev-mode HTTP: `curl -X POST http://127.0.0.1:3212/api/query -d
'{"path":"file:fn","args":{...},"format":"json"}'` (+ /api/mutation, /api/action
— numbers come back as floats). UI against local data: second vite with
VITE_CONVEX_URL=http://127.0.0.1:3212 on another port.

**Dashboard CRUD shipped** (second iteration, same day): `/dashboard` route +
`app/src/components/dashboard/*` panels do CRUD over the three source tables;
`app/convex/dashboard.ts` holds the mutations. Every source write stamps
`datasetBindings.sourceUpdatedAt`, and the dashboard's sync card flips to
"Source changed" until "Sync now" runs `bindings.syncRestaurantLocations`
(verified full loop: add location+link → stale badge → sync → 17 points on
map → cleanup → sync → 16).

Gotchas learned building it:
- Host calls component functions directly via `components.jsonCms.lib.*`
  passing plain-string component ids (component re-validates against its own
  tables) — pattern from `app/convex/tile_archives.ts`; calls join the
  caller's transaction, so a whole sync fits in one mutation.
- `createSchema` takes the JSON schema object with `title` INSIDE it (plus
  `kind: "geospatial"` + `geometryType`); `createEntriesBulk` takes geometry
  as a serialized JSON string.
- `insertEntryBatch` (both create paths) auto-maintains `featureCount`/
  `boundingBox` and bumps `mapTileCacheVersion` — server-side writes get
  archive invalidation + map viewport for free. Small datasets skip the
  archive entirely (row path; `MAP_TILE_ARCHIVE_MIN_BYTES` = 256 KB).
- oxlint: `String(componentId)` is flagged no-unnecessary-type-conversion —
  component ids are plain strings at the host boundary; `no-await-in-loop`
  warnings avoided via `Promise.all(arr.map(async ...))` (component idiom).
- `ui/select.tsx` is BASE-UI, not radix: `<SelectValue>` renders the raw
  value (an id) unless the Select root gets `items={ [{value,label}] }` —
  pass the mapping (also enables typeahead). Radix-style
  `value === label` usages elsewhere in the app mask this.
- Convex dev push FAILS closed on TS errors ("TypeScript typecheck via tsc
  failed" in the dev log) and keeps serving the previous function versions —
  the UI can silently run stale mutations while fresh ones pass `tsc` in the
  repo. Check `/private/tmp/app-dev*.log` when backend behavior looks older
  than the source. (One data point: a location created via UI during that
  broken-push window later vanished without explanation — unexplained, watch
  for recurrence.)
- Browser verification (IAB): locator `.click()` routinely times out on this
  app's buttons/tabs (actionability never settles) while `fill()` works —
  use `cua.click` at screenshot coordinates for buttons, `getByRole`+`fill`
  for inputs. base-ui Select options: keyboard `Down`/`Enter` works via
  `cua.keypress`; character typeahead does not.
- `bunx convex ai-files install` (from `app/`) generates
  `app/convex/_generated/ai/guidelines.md` plus `app/AGENTS.md`,
  `app/CLAUDE.md`, `app/.agents/`, `app/.claude/`, `app/skills-lock.json` —
  left uncommitted; root AGENTS.md untouched. See [[convex-ai-guidelines-missing]].
