# deploy-source demo

A stand-in for the external deployment-data app. It serves the remote-source
HTTP contract that json-data-manager's remote bound sources read
([docs/remote-source-adapter-design.md](../../docs/remote-source-adapter-design.md)).

It is a workspace member so it's committed, watched and tested with the rest
of the repo, but it deliberately **imports nothing from this repo**. It uses
only `Bun.serve` and `bun:sqlite`, so it behaves like a foreign app.

## Run

```bash
bun run demo:deploy-source        # from the repo root: watch mode on :4100
bun run seed                      # from this folder: wipe + regenerate the fixture
bun test                          # contract, revision, and fault tests
```

The fixture is deterministic (200 deployments, seed 42). About 30% of
deployments also carry a MultiLineString route. Data lives in
`data/deploy-source.sqlite`, which is gitignored and created on first start.

Environment overrides: `DEPLOY_SOURCE_PORT` (4100), `DEPLOY_SOURCE_TOKEN`
(`demo-secret`), `DEPLOY_SOURCE_COUNT`, `DEPLOY_SOURCE_SEED`,
`DEPLOY_SOURCE_DB`, `DEPLOY_SOURCE_PUBLIC_URL`.

## Pointing json-data-manager at it

The dev stack runs a local Convex backend, so its actions can reach
localhost:

```bash
bunx convex env set REMOTE_SOURCE_DEPLOYMENTS_URL http://localhost:4100
bunx convex env set REMOTE_SOURCE_DEPLOYMENTS_SECRET demo-secret
```

## Contract routes (bearer token required)

| Route                                     | Returns                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /manifest`                           | Source title, record deep-link template, and per-layer schema, geometry type, `featureCount`, `revision` |
| `GET /layers/{layer}/rows?cursor=&limit=` | One keyset page as a GeoJSON FeatureCollection plus `cursor` (null = done) and `revision`                |

Layers:

- `centroids`: one Point per deployment, carrying all exported attributes.
- `routes`: one MultiLineString per deployment that has one. Each feature is
  keyed by the same deployment id, with `properties.deploymentId` pointing
  back at the centroid.

`notes` is internal and never exported.

**Staleness signal:** each layer's `revision` bumps whenever one of its
exported fields changes. A notes-only edit bumps nothing. json-data-manager
compares the revision it last synced against the manifest to show "update
available".

## Admin routes (bearer token required)

Use these to simulate edits made in the source app:

```bash
TOKEN='authorization: Bearer demo-secret'
curl -H "$TOKEN" -X POST localhost:4100/admin/churn -d '{"count":20}'     # random edits
curl -H "$TOKEN" -X PATCH localhost:4100/admin/deployments/dep_0001 -d '{"status":"retired"}'
curl -H "$TOKEN" -X PATCH localhost:4100/admin/deployments/dep_0001 -d '{"lng":-122.3,"lat":37.7}'
curl -H "$TOKEN" -X PATCH localhost:4100/admin/deployments/dep_0001 -d '{"route":null}'
curl -H "$TOKEN" -X POST localhost:4100/admin/deployments -d '{"name":"new-one"}'
curl -H "$TOKEN" -X DELETE localhost:4100/admin/deployments/dep_0002
curl -H "$TOKEN" -X POST localhost:4100/admin/reset                       # reseed + clear faults
```

Fault injection applies to the contract routes only:

```bash
curl -H "$TOKEN" -X PUT localhost:4100/admin/faults -d '{"failNext":2,"failStatus":429}'
curl -H "$TOKEN" -X PUT localhost:4100/admin/faults -d '{"latencyMs":1500}'
curl -H "$TOKEN" -X PUT localhost:4100/admin/faults -d '{"malformedNext":1}'
curl -H "$TOKEN" -X PUT localhost:4100/admin/faults -d '{"truncate":true}'  # cursor:null after page 1
```

## Unauthenticated

- `GET /` returns the status: per-layer revision and count, plus the active faults.
- `GET /deployments/{id}` returns the full record, including notes. This is
  the manifest's deep-link target.
