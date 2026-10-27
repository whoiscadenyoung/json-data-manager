# Remote source adapter (#78): HTTP transport for bound datasets

Sketch captured 2026-10-27 and revised the same day after review. This is the
open phase 5 of [bound-datasets-design.md](bound-datasets-design.md) §8/§10:
a bound source whose rows live in another app and reach json-cms over HTTP.
The first target is the deployment-data app. Its stand-in for development and
tests is [demo/deploy-source](../demo/deploy-source/README.md).

**v1 scope:** a manifest, per-layer state pages, and a revision-based "update
available" signal that drives a Sync button. History is out of v1: no commit
feed, no History overlay, no snapshots. The foreign app keeps its own history,
audit log and comments, and json-cms mirrors only the current state. The
commit feed from the earlier draft is kept below as a later extension (§7).

## 1. Shape of the change

```
           co-deployed (today)                      remote (#78)
collectRows (action)                      collectRows (action)
  └─ runQuery(readSourceRows)               └─ remoteListRows(source, cursor)
       └─ source.listRows(ctx.db)                └─ fetch(GET {base}/layers/{layer}/rows?cursor=…)
```

`collectRows` is already an action, so it calls the remote reader directly. A
remote source always takes the full-state path: drain all pages, apply rows by
key, then delete keys the run didn't see. Applying, deleting and finalizing
are shared with co-deployed sources.

## 2. Layers: one geometry per entry

json-cms stores **one geometry per entry**: `geometries` is looked up by entry
with `.unique()`, and each dataset declares a single `geometryType`. A
deployment with a centroid _and_ a MultiLineString is therefore two entries in
two datasets.

The foreign app splits them into **layers**, and each layer binds as its own
bound dataset:

| Layer       | Geometry        | Rows                          | Data                                         |
| ----------- | --------------- | ----------------------------- | -------------------------------------------- |
| `centroids` | Point           | every deployment              | all exported attributes                      |
| `routes`    | MultiLineString | deployments that have a route | `deploymentId` (reference), `name`, `status` |

- Both layers key their rows by the deployment id.
- `routes.deploymentId` should become a reference field (`x-reference`) to
  the centroid entry. That would give click-through and reverse lookup
  ("this deployment's route") without duplicating the attributes. **Not built
  yet:** reference values are json-cms entry ids, so the sync would have to
  translate the foreign key through the centroids binding's `bindingEntries`
  map at apply time. Today the field syncs as a plain string.
- A map composes them by adding both datasets as layers.
- A new geometry kind later means a new layer, not a change to the sync
  engine.

The split happens in the foreign app because that's trivial there. Splitting
in json-cms would require one sync run to write two datasets, and today one
binding maps to one dataset with its own cursor and deletion pass.

## 3. Endpoint contract (the foreign app implements)

Both routes are `GET`, return JSON, and require `Authorization: Bearer
<secret>`.

### 3.1 `GET /manifest`

```json
{
  "apiVersion": 1,
  "source": "deployments",
  "title": "Deployments",
  "recordUrlTemplate": "https://deploy-app.example/deployments/{key}",
  "layers": [
    {
      "key": "centroids",
      "title": "Deployments",
      "geometryType": "Point",
      "schema": { "type": "object", "properties": { "name": { "type": "string" } } },
      "schemaVersion": "1",
      "revision": 1042,
      "updatedAt": 1761580800000,
      "featureCount": 200,
      "rowsPath": "/layers/centroids/rows"
    }
  ]
}
```

- `schema` is the JSON Schema the projected dataset is created with. The
  foreign app chooses what to export; comments and audit data stay home.
- `schemaVersion` changes when a layer's exported shape changes. json-cms
  flags the binding instead of writing rows that don't match.
- `revision` is a per-layer counter that goes up whenever an exported field of
  that layer changes. It is the staleness signal (§5). It doesn't need to be
  dense: a timestamp or a max `updatedAt` works, as long as it never
  decreases.
- `recordUrlTemplate` deep-links each entry back to the full record.

### 3.2 `GET /layers/{layer}/rows?cursor=<opaque>&limit=500`

One page as a GeoJSON FeatureCollection, with `cursor`, `revision` and
`layer` added as foreign members (extra top-level keys GeoJSON permits):

```json
{
  "type": "FeatureCollection",
  "layer": "routes",
  "revision": 1042,
  "cursor": "ZGVwXzAwMDE",
  "features": [
    {
      "type": "Feature",
      "id": "dep_0001",
      "properties": { "deploymentId": "dep_0001", "name": "us-west-lumen-1", "status": "live" },
      "geometry": {
        "type": "MultiLineString",
        "coordinates": [
          [
            [-121.98, 37.11],
            [-122.02, 37.11]
          ]
        ]
      }
    }
  ]
}
```

Each feature maps directly to a `ProjectionRow`: `id` → `key`, `properties` →
`data`, `geometry` → `geometry`.

Rules (the #127 invariants, now owned by the foreign app):

- `id` is the stable record id. It is never reused or re-keyed.
- Paging is keyset on an immutable column (the id). Every row that exists for
  the whole drain must appear exactly once. Rows written during the drain may
  or may not appear.
- `cursor: null` only once the layer is exhausted. A truncated drain would
  make the deletion pass remove rows it never saw. The demo's `truncate`
  fault reproduces this.
- `revision` is the layer's revision **when the page was read**. json-cms
  records the first page's revision as the revision it synced to, so a write
  that lands mid-drain shows up as out of date again instead of being lost.

## 4. Auth and config

- Each remote source has a shared secret, stored in a Convex env var
  (`REMOTE_SOURCE_DEPLOYMENTS_SECRET`). The base URL is in
  `REMOTE_SOURCE_DEPLOYMENTS_URL`. Neither is stored in the binding row or
  sent to the client.
- The foreign app compares the bearer token in constant time. The demo
  SHA-256-hashes both sides and then uses `timingSafeEqual`.
- HMAC-signed requests are the upgrade path if replay protection is ever
  needed. They aren't needed for v1 over TLS.

## 5. Staleness and the Sync button

As built (`app/convex/remoteSources.ts`):

- The binding stores `remoteRevision` (the first page's revision at the last
  successful sync) and `remoteSchemaVersion` (the version the dataset was
  built from).
- Each manifest check writes the layer it read, plus `checkedAt` and any
  error, to a `remoteSourceChecks` row per source. This is kept separate from
  the binding so a never-synced source can still show its layer, and so cron
  writes don't contend with the sync engine. Checks run:
  - when the dataset page or dashboard card mounts (`checkIfStale`,
    server-throttled to once a minute),
  - from a cron (`checkAll`, every 15 minutes),
  - when the user clicks **Check**.
- When a check sees `revision > remoteRevision`, it also stamps the binding's
  `sourceUpdatedAt`. Every existing "Out of date" badge (`isSyncStale`)
  therefore covers remote sources without changes.
- `remoteSources.status`/`list` compute `outOfDate` and `schemaChanged` for
  the UI. **Sync** (`remoteSources.sync`) re-reads the manifest and refuses a
  `schemaVersion` mismatch ("unbind and sync again to rebuild"). It then
  starts the engine's full-state run (`sync.startRemoteRun`), which creates
  the dataset from the manifest's layer on the first bind.
- Not built yet: a "Sync all layers" action. Each layer has its own Sync
  button.

## 6. Code changes

### 6.1 `app/convex/sources.ts`

```ts
interface SourceBase { dataset: SourceDataset; key: string; mapping: SourceMapping }

export interface LocalSource extends SourceBase {
  transport: "local";
  listRows(ctx: DbCtx, cursor: string | null): Promise<ProjectionRowPage>;
  commitsSince?(…); newestCommit?(…); buildGeometry?(…);
}

export interface RemoteSource extends SourceBase {
  transport: "http";
  env: { secret: string; url: string };   // env var NAMES, resolved at call time
  layer: string;                          // "centroids" | "routes"
}

export type BoundSource = LocalSource | RemoteSource;
```

The registry gets two entries, `deployments.centroids` and
`deployments.routes`. Their `dataset` descriptors are a fallback: the
manifest's schema and geometry type are what's used at bind time.

### 6.2 New `app/convex/remoteClient.ts`

Plain functions, called from actions:

- `fetchManifestLayer(source)` and `fetchRowsPage(source, cursor)`.
- Requests go through `remoteGet`, which:
  - resolves the env vars,
  - adds the bearer header,
  - applies a 30-second abort timeout,
  - makes up to 3 attempts in total, with backoff, on 429/5xx and network
    errors.
- Responses are validated with zod, which is already an app dependency. A
  malformed page throws, which fails the run loudly through `collectRows`'
  existing catch.

### 6.3 `app/convex/sync.ts`

1. `collectRows` picks its leg through `collectForRun`.
   - Remote sources drain `fetchRowsPage` (`collectRemoteState`) and record
     the first page's revision on the run (`syncRuns.remoteRevision`).
   - Local sources keep the existing `runQuery` hops.
2. `readSourceRows`, `readCommitTail`, `readNewestCommit` and the
   commit-tail apply narrow to a `getLocalSource(key)` that throws for remote
   sources.
3. `ensureBoundDataset` takes an optional dataset override (the manifest's
   layer), passed in by the internal `startRemoteRun`. The public `startRun`
   mutation refuses remote sources.
4. `completeRun` stamps `remoteRevision` from the run.
5. `reconcileAll` skips remote bindings. The `checkAll` cron replaces it for
   them, and syncing is user-initiated in v1.

New optional fields:

- `datasetBindings`: `remoteRevision` and `remoteSchemaVersion`.
- `syncRuns`: `remoteRevision`.

New table: `remoteSourceChecks`.

### 6.4 UI

`RemoteSourceControls` (`app/src/components/remote-source-controls.tsx`)
shows a status badge (Up to date / Update available / Not synced / Source
schema changed), a line reading "synced rev N · source at rev M · checked
…", live run progress, and Sync/Check buttons. It appears in two places:

- On the dataset page's Source row. It renders nothing for local sources.
- In a new dashboard **Remote sources** card, which lists every registered
  remote layer, including never-synced ones. The first Sync creates the
  dataset.

The local-source sync card now hides remote bindings.

## 7. Later (not v1)

- **Commit feed** (`/layers/{layer}/commits?since=<seq>`): incremental sync
  plus the History overlay, mapped from the foreign audit log. The
  `CommitFeedEntry` shape and apply path already exist for local sources.
- **Snapshots** (`/snapshots`): frozen versions through `tags.ingestSnapshots`.
- **Push nudge**: the foreign app POSTs to a json-cms `httpAction` after a
  write, which runs `checkRemote` immediately.
- **Runtime registration**: a "Connect source" UI instead of code registry
  entries.

## 8. Testing

- **[demo/deploy-source](../demo/deploy-source/README.md)**: a workspace
  member that imports nothing from this repo. It serves this contract from
  SQLite and has admin routes for edits and random churn, plus fault
  injection (latency, 429/5xx, malformed bodies, truncated drains). Its own
  `bun test` covers the contract.
- **App convex-test**: stub `fetch` with fixture pages and assert:
  - bind creates both datasets,
  - a full sync, then delete-by-deletion-pass,
  - revision stamping, and the outdated flag after `checkRemote`,
  - a failed run on malformed or 5xx responses after retries.
- **Local end-to-end**: run `bun run demo:deploy-source`, set the two env
  vars on the local Convex backend, bind, then churn and click Sync.
