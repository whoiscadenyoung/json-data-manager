---
name: fix-train-run-2026-10
description: State of the #124–#139 code-review fix-train workflow run — 10/15 merged, #125 blocked with red CI, resume id and remaining issues
metadata:
  type: project
---

The 2026-10-01 fix train (dynamic-workflow run `dwfrun-1c036bee-bfe8-47e4-b5ab-3bcd21f3bc68`, third settings-successor in the family: `dwfrun-b2383f50…` → `dwfrun-fb2f7bff…` → `dwfrun-1c036bee…`; script `.zcode/workflow-drafts/review-fixes.dwf.ts`) implements #124–#139 as one sequential branch/PR per issue with local CI-parity gates + independent review + merge. #137 excluded by maintainer decision.

**🏁 TRAIN COMPLETE 2026-10-01 21:15** (run `dwfrun-1c036bee…`, 7h36m, 303 steps, 363.5M tokens, 0 failed steps). True end state — **14 of 15 issues fixed, #137 excluded by decision, only #125 outstanding:**

- **Merged (14 PRs):** #141→#139, #142→#138, #144→#126, #145→#127, #146→#136, #147→#131, #148→#132, #149→#128, #150→#129, #151→#130, #153→#135, #154→#133, #155→#134, #156→#124 (ADR 0010, editPolicy locked|open). Every merge passed the full local CI-parity gate + independent review; GitHub CI re-ran each on main.
- **Outstanding #125 — PR #143 open draft:** branch predates the 11 later merges (incl. #129's monotonic tileCacheVersion + #149, which touch its files) → needs rebase onto main, then fmt on exactly 2 files (`app/src/lib/tile-archive.test.ts`, `packages/json-cms/src/component/schema.ts`), re-gate, review, merge. The fix itself (contiguity check + `MAP_TILE_ARCHIVE_FORMAT = 2`) was verified failing-before/passing-after.
- **PR #152 open draft (#128 follow-up):** the `scheduleHostCascade` refactor cascading `derivedDatasets.remove` leaks; draft with type-aware oxlint exiting 1 (tail uninformative — check the stale-json-cms-dist phantom-oxlint gotcha before trusting it). implement-133 stashed the local remnant: `stash@{0}` "fix-train: uncommitted scheduleHostCascade refactor + MEMORY.md edits" — reconcile vs #152's branch, recover the MEMORY.md index lines, then drop.
- **After #125 + #152 land:** close umbrella #123 (with #137 closed as do-not-implement), then the manual browser pass for #135/#124 UI changes.
- Run-level accounting note: the final result says "11 merged / 4 blocked" because the #129/#130 re-walks recorded no-op "blocked" outcomes despite being done (merged as #150/#151 in the predecessor run).
- Related: [[dwf-provider-quota-behavior]], [[code-review-2026-09-30]].
