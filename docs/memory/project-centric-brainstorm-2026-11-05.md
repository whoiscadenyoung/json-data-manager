---
name: project-centric-brainstorm-2026-11-05
description: Project-centric experience train FILED — umbrella #254 + ordered sub-issues #255–#262; design approved @ 2e49e86; next work starts at #255
metadata:
  type: project
---

2026-11-05 brainstorm CONVERGED same day. **Projects are now the primary
working context** (datasets/maps/apps/collections tabs = exploratory views).
Design APPROVED: `docs/project-centric-experience-design.md` (committed
@ 2e49e86 with resolved decisions D1–D7 + the no-migration-steps posture).

**Train FILED: umbrella #254, ordered sub-issues #255 → #262** (attached as
native GitHub sub-issues; one PR per issue, in order):

1. #255 membership & roles (owner/editor/viewer RLS rewrite)
2. #256 project catalog: owned vs linked (pin/float/sync/revert)
3. #257 layers + project-owned maps (/maps → explorer; standalone creation retires)
4. #258 dataset_relations (key|spatial) + click→highlight→popup runtime
5. #259 apps in projects; map widgets → STORED maps (inline datasetIds mode dies)
6. #260 unified visibility ladder members|signed-in|link|public + closure preflight
7. #261 anon/link/public serving (frozen-rows-only anon RLS, public routes)
8. #262 explorers + cross-project UX + collections dual-role; tourism walkthrough = train's acceptance test

Key decisions: datasets stay GLOBAL (D1); relations catalog-level (D3);
full visibility ladder in ONE train, no adoption steps — app not in
production, breaking changes fine (D4); app-builder maps persist as real
maps (D7). User's app-builder note: creating maps inside the builder is
fine as long as they're stored as maps and existing maps can be pulled in.

Predecessor context: `feat/project-workspace` (Convex-era, unmerged) is the
SPEC for phases 1–3 (`docs/project-workspace-design.md`); never a merge
source. The app map widget's ad-hoc datasetIds mode = the "two parallel map
stacks" finding. ADRs to write along the way: roles (re-issue of 0011),
visibility model — next numbers from docs/decisions/ (0017+).

Related: [[supabase-migration-2026-11-03]], [[derived-datasets-brainstorm]],
[[break-initiatives-into-ordered-agent-issues]].
