---
name: user-profiles
description: 2026-09-21 user profiles shipped — /users/$userId keyed by the Better Auth authId (= schemas.createdBy), createdBy joined the component's summaries projection, profile page lists a creator's datasets
metadata:
  type: project
---

User profile integration (2026-09-21, session after PR #86): the profile
route is `/users/$userId` where `$userId` is the **Better Auth user id — the
same string the component stamps as `schemas.createdBy`** (`users.authId` on
the mirror row). That choice is load-bearing: every "Created by" surface
(dataset overview, browser creator chips) deep-links with zero resolution
hops, and `users:profile` (`authId` → user row + their dataset summaries) is
the one page-load query.

- `createdBy` joined the json-cms `listSchemaSummaries` projection (handler
  map + validator pick) so list surfaces get authorship without the
  schema/uiSchema payloads; creator **filtering stays host-side** over that
  projection (`users:profile`), not a component-side creator query — dataset
  counts are far below needing an index.
- `users:listProfiles` returns authId/name/image **deliberately without
  email** — the broadest surface gets the least PII; the dataset overview
  keeps `profileByAuthId` when it needs the email fallback.
- Dataset browser cards: the creator chip is a **sibling Link of the card's
  Link, never nested** (anchors can't nest — the HTML parser auto-closes the
  outer one and SSR hydration breaks). Card root became the `Card`, with the
  dataset link and profile chip as siblings.
- Old datasets carry no `createdBy` (pre-#86 or component-direct flows) —
  chips/links correctly absent for them; browser verification needs a dataset
  created signed-in (make one via the UI).
- Verified end-to-end against the local backend (see [[better-auth-setup]]
  for the port/SITE_URL recipe and the session-invalidation gotcha);
  sign-up → create dataset → header chip / card chip / Created-by link all
  land on the profile with the "You" badge and the dataset listed.
