---
name: demo-video
description: "Record a polished product demo video of a web app: a scripted Playwright walkthrough captured to video, then ffmpeg post-production (intro/outro cards, per-section lower-third labels, subtle speedup). Use when asked to create a demo video, screen recording, or video walkthrough of an app and its features."
---

# Demo Video Walkthrough Recorder

## Overview

Produce one narrated-by-labels demo `mp4` of a web app: a headless Chromium
walkthrough drives the real UI against a local dev server while Playwright
records the page, and ffmpeg assembles intro/outro title cards around it with
a lower-third label per feature section and a subtle speedup.

Pipeline (each step has a script below):

1. Prepare a clean demo environment (fresh data, demo account, servers up).
2. Write `record.ts` — the scripted walkthrough; it logs per-section timings.
3. Rehearse with `--dry` (per-step screenshots, no kept video); fix selectors.
4. Reset the environment and record the final take.
5. Render intro/outro cards + section-label PNGs (Playwright).
6. Assemble with ffmpeg (speedup, labels, trim, concat).
7. Verify frames of the final mp4, then deliver.

Total wall time for a ~10-minute video: roughly 45–60 minutes, most of it the
rehearsal + final take. Do NOT skip the rehearsal — selector failures during
the final take cost the whole re-record.

## Prerequisites

- The app runs locally (dev server, e.g. `localhost:3000`) with its backend.
- A way to start from a FRESH database and to mint a demo account (backend
  CLI or seed script) — a clean state makes the narrative deterministic and
  lets "empty → first import" be part of the story.
- `bun` (or node + typescript runner) and `ffmpeg` (`ffmpeg -filters | grep
overlay` — this pipeline uses `overlay`, not `drawtext`, which many ffmpeg
  builds lack).
- A Chromium for Playwright: either `playwright` (auto-manages browsers) or
  `playwright-core` + an explicit `executablePath` (a cached browser or
  "Chrome for Testing" install both work).

Working dir for scratch: `/tmp/demo-rec` — keep it out of the repo; only the
finished mp4 is a deliverable.

## Step 1 — Prepare the environment

- Start the app's servers the way this project does it (check the project's
  memory/docs first — backend before vite, env vars, etc.).
- Reset to a fresh database; push schema; set any required env (e.g. auth
  secrets; make sure the auth `SITE_URL` matches the EXACT browser origin —
  `http://localhost:PORT` vs `127.0.0.1` breaks session cookies).
- Mint the demo account if sign-in is gated.
- Stage demo data files on disk (real sample data beats lorem ipsum; pick one
  geospatial-ish or visually rich primary file, one secondary format, and one
  small file for a later section).
- Verify: `curl -s -o /dev/null -w "%{http_code}" http://localhost:PORT/signin`
  returns the app.

## Step 2 — Write the walkthrough script (`record.ts`)

One file, run with `bun record.ts` (or `npx tsx record.ts`). It defines the
section list, drives the UI, records one video, and writes `steps.json` with
per-section `[start, end]` millisecond offsets that post-production reads.

```ts
// /tmp/demo-rec/record.ts — walkthrough recorder
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright-core";

// point at any chromium: playwright cache, "Chrome for Testing", or system Chrome
const EXE = "/path/to/chromium-or-chrome";
const BASE = "http://localhost:3000";
const OUT = "/tmp/demo-rec";
const DRY = process.argv.includes("--dry");
mkdirSync(`${OUT}/raw`, { recursive: true });

const steps: { name: string; label: string; start: number; end: number }[] = [];
let t0 = 0;
let page: Page;

const pace = (ms: number) => page.waitForTimeout(ms);
async function settle(ms = 600) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await pace(ms);
}
/** Wait for a canvas app (maps/canvas) to actually paint. */
async function waitAppReady(timeout = 45000) {
  await page.waitForSelector("canvas", { timeout }).catch(() => {});
  await pace(1800);
}
/** Filter a picker sheet's search box, then click the row's Add button.
 * Sheets close after each Add — callers re-open for the next pick. */
async function pickerAdd(searchPlaceholder: string, searchText: string) {
  const search = page.getByPlaceholder(searchPlaceholder);
  await search.waitFor();
  await search.fill(searchText);
  await pace(500);
  const row = page.locator("li", { hasText: searchText }).first();
  await row.getByRole("button", { name: /^Add$/ }).click();
  await pace(800);
}

async function step(name: string, label: string, fn: () => Promise<void>) {
  const start = Date.now() - t0;
  try {
    await fn();
  } catch (error) {
    await page.screenshot({ path: `${OUT}/fail-${name}.png` }).catch(() => {});
    console.error(`STEP FAILED: ${name} — screenshot ${OUT}/fail-${name}.png`);
    throw error;
  }
  steps.push({ name, label, start, end: Date.now() - t0 });
  if (DRY) await page.screenshot({ path: `${OUT}/step-${name}.png` }).catch(() => {});
  console.log(
    `ok ${name} [${(start / 1000).toFixed(1)}s -> ${((Date.now() - t0) / 1000).toFixed(1)}s]`,
  );
}

const browser = await chromium.launch({
  executablePath: EXE,
  headless: true,
  // WebGL/canvas apps need SwiftShader in headless:
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
});

// Warm the dev server (first compile is slow) OUTSIDE the recorded context.
const warm = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await warm.newPage().then((p) => p.goto(`${BASE}/`, { timeout: 60000 }));
await warm.close();

const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2, // supersampled text; recordVideo downscales
  recordVideo: { dir: `${OUT}/raw`, size: { width: 1600, height: 1000 } },
});
page = await ctx.newPage();
page.setDefaultTimeout(25000);
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 200)));
t0 = Date.now(); // video timeline starts here

// ---- sections: one step() per feature; label text appears on film ----
await step("signin", "Sign in", async () => {
  await page.goto(`${BASE}/signin`);
  await page.locator("#email").waitFor();
  await pace(1200);
  await page.locator("#email").fill("demo@example.com");
  await page.locator("#password").fill("demo-pass-1234");
  await pace(500);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/`);
  await pace(1500);
});
// await step("import", "Import data", async () => { ...setInputFiles... });
// await step("explore", "Explore tables", async () => { ... });
// await step("outro", "Closing shot", async () => { ... theme toggle, map ... });

await ctx.close(); // flushes the video file
writeFileSync(`${OUT}/steps.json`, JSON.stringify(steps, null, 2));
await browser.close();
console.log(DRY ? "DRY RUN COMPLETE" : "RECORDING COMPLETE");
```

Section-order tips: auth first, then the headline import, exploration, the
"relate/derive" feature, organization views, publishing/versioning, analytics,
and end on the most visual screen. Give each step label 2–4 words of payoff.

### Selector patterns that generalize

- Prefer `getByRole` with FULL accessible names; component libraries often
  render button-styled things as links (`RouterButton` → role=link). When
  unsure: `.getByRole("link", {...}).or(.getByRole("button", {...}))`.
- Scope nav clicks to the header: `getByRole("banner").getByRole("link", …)`
  — breadcrumbs/menu items duplicate link names and strict mode fails.
- File uploads: the visible dropzone is decoration; set files on the hidden
  `input[type="file"]` (`setInputFiles` works on hidden inputs).
- Wizard/review screens: waits belong on OUTCOME text ("N rows from
  file.csv"), not on elements that also match loading states.
- `<select>`-driven pickers: read `textContent` of the trigger first and only
  interact when the value differs (idempotent under retries).
- NEVER `getByText` a title that also appears in captions ("Derived from X",
  breadcrumbs) — click role-scoped elements, or filter by an exact child
  (`getByRole("link").filter({ has: page.locator("h3", { hasText: /^X$/ }) })`).
- Tabs that write `?view=` search params: wait with a predicate on
  `url.pathname`, not a full-URL regex with `$`.

## Step 3 — Rehearse

```bash
cd /tmp/demo-rec && bun record.ts --dry 2>&1 | tail -20
```

Every step screenshots to `step-<name>.png` on success and `fail-<name>.png`
on failure. Fix selectors step by step; re-run. When ALL steps pass, you know
the final take length — decide the speedup factor (see Step 6) from it.

## Step 4 — Record the final take

Reset the environment to fresh (Step 1 again), then:

```bash
rm -rf raw && mkdir raw && bun record.ts
```

## Step 5 — Render cards and section labels (`cards.ts`, `labels.ts`)

```ts
// /tmp/demo-rec/cards.ts — intro/outro cards (styled HTML -> PNG)
import { chromium } from "playwright-core";
const EXE = "/path/to/chromium-or-chrome";
const style = `<style>
  * { margin: 0; } body { width:1600px; height:1000px; display:flex; flex-direction:column;
    align-items:center; justify-content:center; background:radial-gradient(1200px 700px at 50% 40%, #101a30 0%, #0b0f19 70%);
    font-family:-apple-system,"Helvetica Neue",sans-serif; color:#f4f6fb; }
  .badge { font-size:26px; letter-spacing:6px; text-transform:uppercase; color:#7da2ff; margin-bottom:34px; font-weight:600; }
  h1 { font-size:96px; font-weight:800; letter-spacing:-2px; }
  .subtitle { font-size:36px; color:#aab6cf; margin-top:26px; }
  .line { width:120px; height:5px; border-radius:3px; background:#3b82f6; margin-top:44px; }
  .foot { position:absolute; bottom:70px; font-size:24px; color:#5d6b88; }
</style>`;
const card = (badge: string, title: string, subtitle: string, foot: string) =>
  `<!doctype html><html><head>${style}</head><body><div class="badge">${badge}</div><h1>${title}</h1><div class="subtitle">${subtitle}</div><div class="line"></div><div class="foot">${foot}</div></body></html>`;
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.setContent(card("Product demo", "My App", "feature · feature · feature", "footnote"));
await page.screenshot({ path: "/tmp/demo-rec/intro.png" });
await page.setContent(
  card("My App", "Closing headline", "import → organize → analyze", "stack line"),
);
await page.screenshot({ path: "/tmp/demo-rec/outro.png" });
await browser.close();
```

```ts
// /tmp/demo-rec/labels.ts — transparent lower-third PNG per section.
// IMPORTANT: deviceScaleFactor must be 1 — overlays are composited 1:1 and a
// 2x PNG silently lands outside the video frame.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const EXE = "/path/to/chromium-or-chrome";
const OUT = "/tmp/demo-rec";
const steps = JSON.parse(readFileSync(`${OUT}/steps.json`, "utf8"));
rmSync(`${OUT}/labels`, { recursive: true, force: true });
mkdirSync(`${OUT}/labels`, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});
for (const step of steps.filter((s) => s.name !== "outro")) {
  await page.setContent(`<!doctype html><html><head><style>
    * { margin:0; } body { width:1600px; height:1000px; background:transparent; position:relative;
      font-family:-apple-system,"Helvetica Neue",sans-serif; }
    .label { position:absolute; left:64px; bottom:100px; background:rgba(11,15,25,0.82); color:#fff;
      font-size:42px; font-weight:600; padding:18px 30px; border-radius:14px; border-left:6px solid #3b82f6;
      box-shadow:0 6px 24px rgba(0,0,0,0.25); }
  </style></head><body><div class="label">${step.label}</div></body></html>`);
  await page.screenshot({ path: `${OUT}/labels/${step.name}.png`, omitBackground: true });
}
await browser.close();
```

## Step 6 — Assemble (`post.ts` → `assemble.sh`)

```ts
// /tmp/demo-rec/post.ts — emits assemble.sh (intro + sped-up labeled take + outro)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const OUT = "/tmp/demo-rec";
const steps = JSON.parse(readFileSync(`${OUT}/steps.json`, "utf8"));
const video = `${OUT}/raw/${readdirSync(`${OUT}/raw`).find((f) => f.endsWith(".webm"))}`;

const INTRO = 3.5,
  OUTRO = 5;
const SPEED = 1.3; // pick from the rehearsal length: ~8 min raw -> 1.25-1.3; >11 min raw -> 1.35
// If the take ends on stray UI (e.g. an open menu), stop before it:
const outroEnd = steps.find((s) => s.name === "outro")?.end ?? 0;
const MAIN_CUT = Math.max(10, (outroEnd - 3500) / 1000);

const labelFiles = steps
  .filter((s) => s.name !== "outro")
  .map((s) => ({
    file: `${OUT}/labels/${s.name}.png`,
    show: INTRO + s.start / 1000 / SPEED,
    hide: INTRO + Math.max(s.end / 1000 / SPEED, s.start / 1000 / SPEED + 1) - 0.15,
  }));

const inputs = [
  "ffmpeg -y",
  `-loop 1 -t ${INTRO} -i ${OUT}/intro.png`,
  `-t ${MAIN_CUT} -i "${video}"`,
  `-loop 1 -t ${OUTRO} -i ${OUT}/outro.png`,
  ...labelFiles.map((l) => `-i ${l.file}`),
].join(" ");

let chain = `[0:v]scale=1600:1000:flags=lanczos,setsar=1,fps=30,format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${INTRO - 0.5}:d=0.5[v0];
[1:v]setpts=PTS/${SPEED},trim=duration=${MAIN_CUT / SPEED},scale=1600:1000:flags=lanczos,setsar=1,fps=30,format=yuv420p[v1raw];
`;
let prev = "v1raw";
labelFiles.forEach((l, i) => {
  chain += `[${prev}][${3 + i}:v]overlay=0:0:enable='between(t,${l.show.toFixed(2)},${l.hide.toFixed(2)})'[v1_${i}];\n`;
  prev = `v1_${i}`;
});
chain += `[${prev}]format=yuv420p[v1];
[2:v]scale=1600:1000:flags=lanczos,setsar=1,fps=30,format=yuv420p,fade=t=in:st=0.5:d=0.6,fade=t=out:st=${OUTRO - 0.7}:d=0.7[v2];
[v0][v1][v2]concat=n=3:v=1:a=0,format=yuv420p[vout]`;

writeFileSync(
  `${OUT}/assemble.sh`,
  [
    inputs,
    `-filter_complex "${chain.replaceAll("\n", " ").replaceAll(/ {2,}/g, " ")}"`,
    '-map "[vout]" -an -c:v libx264 -crf 19 -preset medium -movflags +faststart',
    `${OUT}/demo.mp4`,
  ].join(" "),
);
```

Then: `bash assemble.sh` (~2–4 min for a 10-minute video).

## Step 7 — Verify and deliver

- `ffprobe`: duration ≈ `INTRO + MAIN_CUT/SPEED + OUTRO`.
- Extract spot frames and LOOK at them: intro card, one frame per section
  (especially any newly added section), outro card:
  `ffmpeg -ss <t> -i demo.mp4 -frames:v 1 f.png`.
- Copy the mp4 to its delivery location (e.g. the repo's `docs/demo/`) —
  leave it untracked unless asked to commit.

## Gotchas that cost real time (read before debugging)

- **Playwright screencast emits frames only on paint.** `ffmpeg -ss N` on the
  RAW webm shows stale frames on static screens. To inspect the raw take,
  decode sequentially (`-sseof -15 -i raw.webm f-%03d.png`) or build contact
  sheets (`-vf "fps=1/10,scale=480:300,tile=6x10"`). The final mp4 seeks fine.
- **Raw webm duration ≈ the step log's total** — trust steps.json offsets ÷
  SPEED for label windows; don't eyeball timestamps.
- **First page load compiles the dev server** — warm it in a throwaway
  context before the recorded context, or the video opens on a white screen.
- **deviceScaleFactor 2** for crisp text, but label PNGs must be rendered at
  scale 1 (a 2× overlay PNG silently misses the frame).
- **Keep pacing honest**: waits that guard real loads (imports, WASM boots,
  tile/map paint) must stay generous — only trim the cosmetic `pace()` calls.
  A step that passes in rehearsal passes identically in the take.
- **A demo walkthrough doubles as exploratory testing.** Expect to find 1–2
  real bugs in rarely-driven UI paths; fix them in the app (separately,
  properly) rather than scripting around them, then rehearse again.
- **Silence is fine**; these videos read as screencasts. Don't add music.

## Project-specific recipes

This skill is generic. Project-specific server startup, backend CLI recipes,
and data-file locations live in the project's own memory/docs (for
json-data-manager: `docs/memory/demo-recording-recipe.md`).
