---
name: local-dev-verification
description: How to run/verify json-data-manager locally — dev stack often
  already running; in-app browser can't reach localhost, verify via curl SSR
  instead; app consumes json-cms from dist, rebuild the package after edits
metadata:
  node_type: memory
  type: project
  originSessionId: sess_0a10137a-f94d-4f84-9e51-6fc22a4af704
---

Local run/verify facts for json-data-manager (learned 2026-09-15):

- The dev stack is often already running (`bun run dev` from `app/`): vite serves the app on :3000, Convex local backend on :3212, component backend on :3216/:3217. Check `lsof -i :3000` before starting anything new. Gotcha: lsof prints port 3000 under the service name `hbci` (and 3216 as `surveyinst`), so match on PIDs/commands, not just numbers.
- The Browser Use in-app browser cannot navigate to localhost/127.0.0.1 — `tab.goto()` times out (nav never commits, tab stays on about:blank). To verify local pages, curl the SSR HTML instead.
- Convex-backed pages SSR as just the loading spinner (`useQuery` returns undefined server-side; data fills in client-side). A spinner-only curl response is normal, not a bug — check the `data-tsd-source` attribute points into the expected route file.
- If a page that worked suddenly renders blank, check `git diff` for a route file clobbered by a TanStack Router route-generator stub (9 lines: `RouteComponent` returning `Hello "/path/"!`, single quotes/no semicolons — generator style, not repo style). `git restore <file>` recovers it from HEAD. This hit `app/src/routes/datasets/index.tsx` on 2026-09-15.
- `app` consumes `@caden/json-cms` from its built `dist` (workspace symlink; the package exports map points at `dist/react/ui/index.js`), so after editing `packages/json-cms/src` run `bun run build` (tsc) in that package — the running vite server then serves the new code without restart. Verify pickup with `curl 'http://localhost:3000/@fs/<abs path>/packages/json-cms/dist/react/ui/<file>.js' | grep <marker string>`. The package's own `bun run typecheck` covers package + example apps; its `bun run test` is fast (~2s, 160 tests).
- `app/` has no typecheck script — run `bunx tsc --noEmit` from `app/`. Its `bun run test` (vitest) prints a benign "close timed out after 10000ms … prevents Vite server from exiting" teardown warning after the tests pass — not a failure.
- Component-side Convex changes (`packages/json-cms/src/component/*` — mutations or table validators in `schema.ts`) are picked up by the running `convex dev` (part of `bun run dev`) and redeployed to the local backend automatically. Relaxing a table validator is safe for existing rows; if a stale validator error persists at runtime, restart `bun run dev` to force the schema push. (Learned making `schemas.description` optional, commit cdee16d.)
- Adding a NEW component function is a four-place + two-codegen chain (learned adding `getEntryGeometry`, commit fe7d969): (1) the query/mutation in `packages/json-cms/src/component/lib.ts`; (2) a wrapper in `src/client/index.ts` — `exposeApi` is HAND-WRITTEN per-function wrappers, nothing automatic, and id args use `v.string()` not `v.id()` because the host deployment doesn't know the component's tables; (3) destructure it in the app's `app/convex/<module>.ts`; (4) regenerate: `bun run build:codegen` in the package FIRST (component codegen — the app's codegen resolves component fn types through the package's generated `component.d.ts`), then `bunx convex codegen` in `app/`. Skipping the package codegen makes app codegen fail with a type error on the new destructure.
- `Map` imported from `#/components/ui/map` shadows the global `Map` constructor — in files that import it use `new globalThis.Map(...)` (entries-map precedent) or tsc reports bizarre construct-signature errors.
- Path gotcha: from `packages/json-cms`, the app is at `../../app` (not `../app`) — a failed `cd` mid-compound-command silently leaves cwd in the package, and running `bunx convex codegen` there connects to the package's OWN example deployment (3216/3217) and regenerates `packages/json-cms/example/convex/_generated` (harmless; commit those regenerated files alongside if the function is real). Always `pwd`-check before verification commands.

- There is NO locally-bundled Convex dashboard in this setup — nothing listens on 6790 (checked 2026-09-16). With the current `convex` version, `convex dev` tunnels the local deployment to the cloud dashboard, and the URL is printed in the dev log at startup: `dashboard: https://dashboard.convex.dev/t/caden-young-noblis-org/app/local-caden_young_noblis_org-app` (requires the dev session running; opens directly if signed in to Convex). The local backend process (`convex-lo`) serves only the API on 3212 plus an internal port on 3213 — both 404 on `/dashboard`. Probe listeners with `lsof -nP -iTCP -sTCP:LISTEN` when looking for dashboard/app ports.

Related: [[gis-feature-initiative]]
