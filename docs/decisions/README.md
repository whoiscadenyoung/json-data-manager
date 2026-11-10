# Decision records

Numbered, ADR-style (context → decision → consequences). New decisions get
the next number; superseded records stay. The one-line index:

| #    | Decision                                                                    | Status      |
| ---- | --------------------------------------------------------------------------- | ----------- |
| 0001 | Backend-agnostic React UI                                                   | accepted    |
| 0002 | Convex component extraction (`@caden/json-cms`)                             | accepted    |
| 0003 | Geometry storage and tile archives (PMTiles)                                | accepted    |
| 0004 | Bound-datasets projection (foreign-app read-only sync)                      | accepted    |
| 0005 | Derived datasets: catalog-level, transform specs                            | accepted    |
| 0006 | Better Auth hybrid component (Convex era)                                   | superseded¹ |
| 0007 | Component actor authz (`exposeApi` per-function policy)                     | superseded¹ |
| 0008 | Catalog lifecycle (draft→publish, versioned consumption, bundles)           | accepted²   |
| 0009 | Trusted-collaborator catalog (published artifacts co-editable)              | accepted²   |
| 0010 | Dataset edit policy (`open`/`locked`)                                       | accepted²   |
| 0011 | App builder feature module                                                  | accepted²   |
| 0012 | Layer styles optional module                                                | retired³    |
| 0013 | Point markers: SDF sprite + stored uploads                                  | accepted²   |
| 0014 | Workspace packages and module boundaries (two tiers)                        | accepted    |
| 0015 | Supabase Postgres backend (the migration's contract)                        | implemented |
| 0016 | Self-hosted Supabase on a VPS                                               | accepted    |
| 0017 | Project membership & roles (RLS rewrite)                                    | implemented |
| 0018 | Project catalog: owned vs linked artifacts (pin/float/sync)                 | implemented |
| 0019 | Layers as first-class artifacts; project-owned maps                         | implemented |
| 0020 | Dataset relations (key/spatial) at the catalog level                        | implemented |
| 0021 | Apps in projects: stored-map widgets, freeze/publish                        | implemented |
| 0022 | Visibility ladder + closure preflight/promotion                             | implemented |
| 0023 | Anon serving: frozen rows only, no live-table policies                      | implemented |
| 0024 | Explorers browse, projects create — cross-project reuse surfaces            | accepted    |
| 0025 | Row-path geometry loading off the main thread (worker offload, sized takes) | accepted    |

¹ The Convex-era auth/authz mechanics were archived by the Supabase
migration (ADR 0015); the records remain as history.
² Implemented pre-migration and carried to Postgres by the migration stages;
the mechanism now lives in the PG schema/RLS.
³ Retired by [project 3] (#257): style moved onto the layer row (ADR 0019);
the optional-module posture and its extension slots went with it.
