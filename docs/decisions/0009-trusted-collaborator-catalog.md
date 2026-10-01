# 9. Trusted-collaborator catalog: published artifacts are co-editable by any signed-in user

- Status: accepted
- Date: 2026-09-30
- Refines: ADR 0007 (the `auth` hook contract) and the stage-8 sharing model
  (#104 / #121). It does not supersede them.

## Context

The 2026-09-30 code review (`docs/code-review-2026-09-30.md`, umbrella #123)
found that `auth()` in `app/convex/auth.ts` denies writes only for foreign
`lifecycle: "draft"` rows and `publishedVisibility: "author"` rows. Any
signed-in user can therefore update, clear, delete or import into an
ordinary published dataset, and can unbind bound datasets. No document said
whether this was intended.

Stage 8 had already recorded that maps, collections and groups are shared
catalog artifacts with no identity dimension (`sharing.test.ts`).

## Decision

- **Every signed-in user is a trusted collaborator.** Published datasets,
  maps, collections and groups are **co-editable by design**.
- **Creator-only boundaries stay as shipped:**
  - drafts (`lifecycle: "draft"`) are private to their creator;
  - `publishedVisibility: "author"` rows are readable and writable only by
    their creator.
- **Read-only guarantees are not trust-based and stay absolute.** Frozen
  versions (`lineage`) and bound datasets (`source`, with `boundWrite`
  attestation) reject data and schema writes for everyone. Any path that
  bypasses this is a bug, not a policy question (for example
  `updateSchema`, #129).
- **Integrity hardening is still required under trust.** Accidental or buggy
  cross-dataset effects should be prevented even between trusted users.
  Examples: storage-id provenance (#131), the SQL sandbox (#132), and
  data-export table scoping (#137).
- **The trust assumption must stay true.** Who can sign in has to be
  controlled, so signup gating is tracked in #136.

## Consequences

- Authz findings about co-editing published data are closed as _by design_.
  Agents must not add per-user write restrictions ad hoc.
- Opt-in locking is future work: #124 adds an `editPolicy`
  (`"open" | "locked"`, later `"team"`) with `"open"` as the default. A
  locked dataset gets creator-only writes, and a new ADR will supersede this
  one's co-editable clause for locked datasets.
- UI should confirm destructive actions on shared artifacts (delete, clear,
  unbind, retire), because another collaborator's work may be affected
  (#135).

## Addendum (2026-09-30, #136): the signup policy that keeps the trust assumption true

This addendum records the decision the original ADR anticipated ("Who can
sign in has to be controlled"): **option (a) — sign-up is disabled; accounts
are admin-created.**

- **The public auth surface has `emailAndPassword.disableSignUp: true`**
  (`createAuth` in `app/convex/auth.ts`). No self-serve registration: a
  signed-in user is a trusted collaborator, so "anyone who can reach the app
  can register" would make the trust model vacuous. Sign-in is unaffected.
- **Accounts are created host-side**, through the internal
  `auth.createAccount` mutation (`app/convex/auth.ts`). Internal means only
  host code — or an operator running `convex run` with the deployment's
  admin key — can call it; no browser or client SDK can. It drives Better
  Auth's own sign-up endpoint with the one flag flipped
  (`createAuth(ctx, { allowSignUp: true })`), so password hashing, the
  credential account row and the `users` mirror trigger all behave exactly
  as before.
- **Why not Better Auth's admin API:** the admin plugin declares extra
  `user` fields (`role`, `banned`, …) that the
  @convex-dev/better-auth component's schema has no columns for, so
  `auth.api.createUser` fails the component's validators. The flag-flip
  through the ordinary sign-up endpoint is the equivalent that fits the
  component (ADR 0006).
- **Operator recipe — and the local-dev first-account flow.** With signup
  closed, the first account on any deployment (local included) comes from
  the operator:
  ```
  bunx convex run auth:createAccount '{"email": "you@example.com", "password": "at-least-8-chars", "name": "Your Name"}'
  ```
  Against the local backend, add the connection flags from the
  local-backend recipe: `--url http://127.0.0.1:3212 --admin-key <adminKey
from app/.convex/local/default/config.json>`. Then sign in through the UI
  (which is now sign-in only — the /signin page has no sign-up mode).
- **Profiles stop leaking emails.** Under co-editable-by-design trust,
  profile surfaces are co-browsable, so `users.profile` /
  `users.profileByAuthId` now return the same public projection as
  `users.listProfiles` (authId, name, image — plus the row's creation time
  for the profile page's "Joined" line), with the email included only when
  the viewer IS that user. This revises the old recorded intent that
  `profileByAuthId` "does resolve email" for every viewer.
- **SITE_URL fails closed.** A missing `SITE_URL` throws at module init on
  any non-dev deployment (`resolveSiteUrl` in `app/convex/auth.ts`): Better
  Auth issues session cookies and accepts origins only for that URL, so
  booting with a silent localhost fallback in production would strand every
  session. The localhost fallback survives for local dev only (no
  `CONVEX_DEPLOYMENT`, a `local-…` backend, or a `dev:` deployment).
