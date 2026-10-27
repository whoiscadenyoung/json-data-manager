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
- `routes.deploymentId` becomes a reference field (`x-reference`) to the
  centroid entry. That gives click-through and reverse lookup ("this
  deployment's route") without duplicating the attributes.
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

- The binding stores `remoteRevision` (the first page's revision at the last
  successful sync) and `remoteSchemaVersion`.
- A lightweight `checkRemote` action fetches `/manifest` and stamps
  `latestRemoteRevision` and `checkedAt` on each layer's binding. It runs:
  - when the dataset page opens (throttled to about once a minute),
  - from a cron (every 15 minutes, for list badges),
  - when the user clicks "Check".
- The UI compares `latestRemoteRevision > remoteRevision` and shows "Update
  available" plus a **Sync** button, which starts the existing full-state
  sync. A `schemaVersion` mismatch shows "Source schema changed" and blocks
  Sync until someone acknowledges it.
- The source is defined as a whole: one manifest lists every layer, so a
  single "Sync all layers" action can run each layer's binding in turn.

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

### 6.2 New `app/convex/remoteSource.ts`

Plain functions, called from actions:

- `remoteManifest(source)` and `remoteListRows(source, cursor)`.
- Requests go through `remoteGet`, which resolves the env vars, adds the
  bearer header, applies `AbortSignal.timeout(30_000)`, and retries
  429/5xx up to 3 times with backoff.
- Responses are validated with zod, which is already an app dependency. A
  malformed page throws, which fails the run loudly through `collectRows`'
  existing catch.

### 6.3 `app/convex/sync.ts`

1. `collectFullState` branches on transport. For `http` it drains
   `remoteListRows` and records the first page's revision; otherwise it uses
   the existing `runQuery` hops. `collectCommitTail` refuses remote sources.
2. `readSourceRows`, `readCommitTail` and `readNewestCommit` narrow to a
   `getLocalSource(key)` that throws for remote sources.
3. Bind-time dataset creation (around line 176) runs from an action for
   remote sources. It fetches `/manifest`, then creates the dataset from the
   layer's schema and geometry type and stamps the revision fields.
4. `finalizeRun` stamps `remoteRevision`, and the new `checkRemote`
   internal action is added.
5. The reconcile cron for remote bindings is replaced by the `checkRemote`
   cron. Syncing is user-initiated in v1.

New optional `datasetBindings` fields: `remoteRevision`,
`latestRemoteRevision`, `remoteSchemaVersion`, `remoteCheckedAt`.

### 6.4 UI

On the dataset page, the binding card gets a "Last synced revision N · source
at M" line, an Update available badge, and Sync and Check buttons. Lists
reuse the Synced badge with an "outdated" variant.

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
