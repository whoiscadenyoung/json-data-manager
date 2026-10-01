---
name: fix-train-run-2026-10
description: State of the #124–#139 code-review fix-train workflow run — 10/15 merged, #125 blocked with red CI, resume id and remaining issues
metadata:
  type: project
---

The 2026-10-01 fix train (dynamic-workflow run `dwfrun-1c036bee-bfe8-47e4-b5ab-3bcd21f3bc68`, third settings-successor in the family: `dwfrun-b2383f50…` → `dwfrun-fb2f7bff…` → `dwfrun-1c036bee…`; script `.zcode/workflow-drafts/review-fixes.dwf.ts`) implements #124–#139 as one sequential branch/PR per issue with local CI-parity gates + independent review + merge. #137 excluded by maintainer decision.

**🏁 REVIEW FULLY CLOSED 2026-10-01 evening.** Post-train close-out landed the last two PRs and closed umbrella #123. All 15 review issues (#124–#139) resolved: **14 fixed and merged (#141–#156), #137 closed as do-not-implement by maintainer decision** (issue stays open as the latent-defects record for a future wire-in).

Close-out details worth remembering:
- **#143 (#125) landed via a semantic cross-breed rebase:** the branch predated 11 merges, so its lib.ts/lib.test.ts conflicts were resolved as unions — main's #128 batched delete + #129 monotonic `mapTileCacheVersion` bump kept, #125's `mapTileArchiveFormat` reset grafted into `finishClear`; `isTileArchiveStale` got #134's skip memo + #131's built-version signal + #125's `mapTileArchiveFormatCurrent === false` gate (absent flag falls through — old-backend skew safety); the summaries projection serves the gate as a DERIVED boolean next to `MAP_TILE_ARCHIVE_FORMAT` so the app never holds a drifting copy of the constant. Its tests needed post-#131/#149 surface fixes (`limit` required on listSchemaSummaries; storageId gone from meta — url is the install fingerprint).
- **#152 (#128 follow-up) was the stale-dist phantom:** its red type-aware oxlint gate passed immediately after a fresh json-cms dist build (rebuild dists before trusting lint — confirmed again).
- The stash was 100% subsumed by #152's pushed commits + the re-committed MEMORY.md line; dropped.
- Gotcha re-confirmed: `cmd | tail` masks exit codes — a failing fmt:check slipped through a `&&` chain into a merged commit; fixed with an immediate style commit (the train's own precedent).
- Manual follow-up: in-browser verification of the #135 sign-in gate and #124 lock toggles.

Related: [[dwf-provider-quota-behavior]], [[code-review-2026-09-30]].
