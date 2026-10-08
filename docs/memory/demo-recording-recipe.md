---
name: demo-recording-recipe
description: How the product demo video is recorded — local-backend demo DB +
  Playwright walkthrough harness in /tmp/demo-rec, plus the DuckDB worker URL
  bug the first browser SQL run exposed
metadata:
  type: project
---

Product demo recording recipe (built 2026-10-08; delivered video:
`docs/demo/json-data-manager-demo.mp4`, ~7.9 min, untracked; full harness
lives in /tmp/demo-rec — scratch, re-buildable from this recipe):

- **Stack**: fresh local backend DB (`demo.sqlite3` positional arg, same
  --instance-secret/--instance-name from config.json, cwd =
  `app/.convex/local/default/`) → `bunx convex dev --once --url/--admin-key`
  from `app/` → `convex env set SITE_URL http://localhost:3000` (localhost,
  NOT 127.0.0.1 — Better Auth checks the browser origin) +
  `BETTER_AUTH_SECRET` → `bunx convex run auth:createAccount '{...}'` →
  `bunx vite --port 3000 --strictPort` (no `convex dev` watcher).
- **Harness**: `/tmp/demo-rec/record.ts` (bun + playwright-core@1.59.1,
  executablePath = the cached
  `~/Library/Caches/ms-playwright/chromium-1243/.../Google Chrome for
  Testing`), viewport 1600x1000 @ dsf 2, `recordVideo` per context, launch
  args `--use-angle=swiftshader --enable-unsafe-swiftshader` (WebGL works;
  MapLibre + CARTO basemap render fine headless). Steps log ms offsets to
  steps.json → `post.ts` emits an ffmpeg drawtext lower-third per section
  (font /System/Library/Fonts/SFNS.ttf), 1.25x setpts speedup, intro/outro
  PNG cards (cards.ts) concatenated in. `bun record.ts --dry` = rehearsal
  with per-step screenshots.
- **Selector gotchas**: RouterButton renders as role=link not button; nav
  links must be scoped `getByRole("banner")` (breadcrumbs collide); picker
  sheets (datasets, map layers) CLOSE after each Add — reopen between adds;
  the importer's file input is a hidden `input[type="file"]`; title input is
  `#schema-meta-title`; the importer's label text matches both coordinate
  selects because `<option>`s are inside the labels (anchor hasText with
  /^Latitude/); the Analyze tab shows a "New analysis" empty state first;
  `Theme:` header control is a dropdown (Auto/Light/Dark), not a cycle
  toggle.
- **Timing**: Playwright screencast only emits frames on paint — ffmpeg
  `-ss` seeks on the raw webm show stale frames on static screens; decode
  sequentially (`-sseof` + image2) to inspect the tail.
- **App bug fixed live (this session, commit on main):** the first real
  browser SQL query (roadmap stage 9's "still unverified" item) failed —
  DuckDB's `?url` assets are ROOT-RELATIVE and duckdb's worker consumes them
  via importScripts/`new Request()` inside a blob-born worker, which has no
  base URL → "URL is invalid". Fix in `analysis-duckdb.ts`: resolve
  mainModule + mainWorker against `globalThis.location.href` before handing
  them to the bundle. Also: rebuilding `packages/json-cms` dist mid-session
  is NOT picked up by the running vite until it restarts with
  `app/node_modules/.vite/deps` cleared.
- **Demo data**: `.input/funding/ss4a-awards/geojson/fy24_implementation_grant_awards.geojson`
  (70 polygons), `.input/funding/tiger_build_raise-awards/TIGER 2009 - BUILD
  2026 Awards.xlsx` (1512 rows, Latitude/Longitude columns → geospatial
  coordinate-picker flow), plus a scratch `state-priorities.csv` (16 states)
  that the project publishes as "FY26 State Priorities" so the TRANSFORM
  section can lookup-join it onto SS4A by State ("SS4A awards with state
  priorities"; the payoff shot is the editor preview + catalog Derived badge —
  derived cards link back to the source's Transform tab, first-class derived
  pages are stage 3). Analysis SQL: `SELECT "State", count(*) AS awards FROM
  source GROUP BY "State" ORDER BY awards DESC`.
  v2 gotchas: the transform editor opens from the tab's list ("New transform")
  but a prior autosaved draft AUTO-RESUMES past the list; operations start
  EMPTY ("Add lookup step" first); keys are selects `#transform-base-key-0` /
  `#transform-lookup-key-0`; "Save transform" closes the editor back to the
  list itself. The Export beat's dialog never rendered on film (click+Escape
  raced) — harmless button-focus flash only. Second app bug fixed for v2: the
  transform PREVIEW hung on "Loading every row…" forever — its effect cleanup
  cancelled the debounced run while the content guard then early-returned, so
  any render inside the 600ms window (autosave, select re-render) killed it;
  fix keeps the timer in a ref and reschedules only on real content changes
  (transform-preview.tsx).

Related: [[convex-dev-stack-outage-workaround]], [[better-auth-setup]],
[[local-dev-verification]]
