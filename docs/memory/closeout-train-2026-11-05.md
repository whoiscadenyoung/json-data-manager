---
name: closeout-train-2026-11-05
description: 2026-11-05 closeout train session — #220–#226 all merged same-day, two new defects found+fixed (#233/#234), what remains (#227–#230) and who owns each
metadata:
  type: project
---

2026-11-05 closeout session: **#220–#226 all merged same-day** (PRs #231/#232/#235/#236/#237/#238/#239/#240; main @ b43c6ac; issues #220–#226 + #233 closed). One PR per issue, all locally gated, merged bottom-up as a main-based stack.

**Defects found while verifying (filed, not fixed inline):**

- #233 (FIXED same-day, PR #235): compose realtime was dead by construction — kong forwards with the upstream host as the Host header and realtime derives its tenant from it; `SEED_SELF_HOST` seeds external_id `realtime-dev`, so the upstream must be named `realtime-dev` (network alias), matching the official supabase/docker stack. Symptom: `TenantNotFound: Tenant not found: realtime` + `CHANNEL_ERROR` on subscribe.
- #234 (OPEN): CI `Test (app)` flakes across DIFFERENT int-test files per run (first the named do-not-fix pair, rerun `pg-storage-policies` + `pg-stage7-bindings` with storage.objects RLS denials). Suspect: claims GUC (`set_config request.jwt.claims`) interleaving across the shared service DB under runner load. Two reruns both red — retry is not a remedy; needs triage (per-file DB isolation or serial int execution).

**Verification techniques that worked:** two-client realtime probe = sign in THROUGH the client (`auth.signInWithPassword`) — a pre-minted token via `accessToken`/headers never reaches the realtime socket (silent no-delivery, RLS denies the anon role); write leg via `docker exec psql` is a genuine broker broadcast. Bundle grep methodology: match module content (`ConvexClient|convex/browser|convex/react|_generated/api`), never the word "convex" — chunk filenames (`archived-convex-surface-*.js`), PG query keys (`pg:entries appBuilderRecords`) and supabase-realtime's `socket.setAuth` all false-match.

**#226 scope lesson:** only the two workers carried LIVE dormant Convex code; the ~30 api-importing sources are unreachable from the route tree and tree-shake out entirely — bundle grep passes without deleting inert sources (issue scope: live imports only).

**#224 resolution:** decision (b) "louder refusal" — and it already shipped: 0012's `publish_version` guard refuses storage-backed oversized freezes; option (a) was already recorded impossible (no SQL path reads Storage bytes). Behavioral test added; 0017 fixed the 0016 leftover (create-or-replace with a NEW signature leaves the old function + grants behind — check `pg_proc` when changing RPC signatures).

**Remaining train:** #227 (live verification checklist — browser pass, two-browser realtime, devtools zero-Convex, 20k cold-open; evidence on issue), #228 (re-triage map-perf backlog with PG numbers — bench fixtures in /tmp/jdm-ab, bench user via gotrue admin API), #229 (decide #78/#72 bound-datasets future — user product call), #230 (VPS go-live — needs the user's VPS; ends with ADR 0016 → "deployed" + restore rehearsal). CI green on main is blocked by #234.
