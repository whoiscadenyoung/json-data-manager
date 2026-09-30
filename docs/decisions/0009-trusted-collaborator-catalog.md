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
