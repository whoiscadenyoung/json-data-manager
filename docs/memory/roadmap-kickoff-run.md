---
name: roadmap-kickoff-run
description: 2026-09-23 kickoff workflow completed — issue train #88–#105 filed, Phase 0 shipped as draft PRs #106–#110, nothing merged, stages 1–9 are issues only
metadata:
  type: project
---

The data-platform roadmap kickoff run (dynamic workflow `dwfrun-0199d0ad`,
2026-09-23) **completed**. Delivered:

- **Issue train filed**: umbrella issue
  [#88](https://github.com/whoiscadenyoung/json-data-manager/issues/88) + 17
  issues — Phase 0 (#89 0.1 auth gating, #90 0.2 row seam, #91 0.3 version
  freezing, #92 0.4 coercion utils, #93 0.5 CI) and stages 1–9 (#94–#105,
  with 3/5/7 split a/b). Each carries "Implements", "Decisions recorded",
  testable acceptance criteria; the train was reviewed by two independent
  reviewers (implementer lens, roadmap-grounding lens) before filing. #88
  holds the ordered index comment.
- **PROGRESS 2026-09-29: 🏁 ROADMAP COMPLETE.** Phase 0 (#106–#110) AND all
  nine stages (#111 engine, #112 registry/builder, #113/#114 surfacing,
  #115 rollup/composition/geometrySource, #116 lifecycle flag, #117
  materialized publish, #118 versioned consumption, #119 projects,
  #120 bundle publish + fork, #121 sharing/isolation, #122 analysis layer)
  ALL MERGED — issues #89–#105 closed and umbrella #88 closed with the
  full delivery record (stage→PR table + manual-verification list:
  https://github.com/whoiscadenyoung/json-data-manager/issues/88#issuecomment-5897082532).
  **Still worth doing manually:** two-account live check of auth gating +
  isolation; first real materialized publish; first browser SQL query;
  a convex-test for freezeVersion idempotency. Parquet sidecar deferred
  by design. Each stage ran the same pipeline: contract from design docs →
  gates (json-cms build/typecheck/test, app tests, oxlint) → independent
  lens review(s) with re-gating → draft PR → merge with CI green.
- Gates per PR (script-run): json-cms build + typecheck + tests, app vitest,
  root oxlint; `oxfmt --check` excluded (pre-existing failures).

**Known caveats**: 0.1 auth gating was never exercised against a live
deployment (rests on untouched Better Auth plumbing + tests — verify sign-out
blocks data on first run); 0.3's `freezeVersion` idempotency re-check has no
convex-test (app has no convex-test harness — a follow-up test would close
it); 0.2 export byte-identity is by code identity + new
`dataset-rows.test.ts`, not a live export. Push of #106 hit the
[[gh-push-workflow-scope]] trap. Run stalled twice on plan quota
(1310 monthly / 1308 five-hour) and self-recovered both times. Related:
[[derived-datasets-brainstorm]], [[better-auth-setup]], [[mvp-gap-assessment]].
