---
name: retire-version-pin-refusal
description: "#126 decision — tags.retireVersion REFUSES while any consumerReferences row pins the version (by_pinnedSchemaId index); policy-store pins do not block; attempt-chain reads filter to completed attempts whose frozen row survives"
metadata:
  type: project
---

The #126 retention/delta fix (2026-09-30) pinned three recorded decisions:

1. **`tags.retireVersion` REFUSES, never repins** while a
   `consumerReferences` row still pins the version (lookup via the
   `by_pinnedSchemaId` index): a pin is the consumer's explicit choice of one
   exact immutable version — silently repinning to head would change what
   another dataset renders without consent. Policy-store pins
   (`versionPolicies`/`datasetBindings.pinnedRefs`) deliberately do NOT block
   a manual retire: they are retention exemptions, not render targets, and the
   stale ref they keep is inert. If a future ask wants "retire = force-float
   consumers", this is the decision to reverse.

2. **Attempt-chain reads filter, existence not markers**: the derived-chain
   version feed (`consumption.completedAttemptsFor` →
   `survivingAttemptsFor`) filters to `status === "completed"` AND to
   attempts whose `publishedSchemaId` still resolves. Existence (a
   `tryGetSchema` per attempt) was chosen over a `retiredAt` patch because it
   self-heals attempts orphaned by ANY retirement path (retention, manual
   retire, the publish sweep) with no backfill; the feed runs once per
   publish/revert, not in the badge loops. The retire loop additionally
   tolerates "Schema not found" as defense in depth.

3. **Delta truncation is flagged, not hidden**: `versionRowsBounded` reads
   VERSION_DIFF_LIMIT+1 rows so `truncated` is exact (at-limit = not
   truncated); both delta recorders store `truncated: true` on `tagDeltas`
   and both `consumption.storedDelta` / `tags.getVersionDelta` return it;
   the UI surfaces it via `DeltaTruncationNotice` in VersionCompare.

Related: [[code-review-2026-09-30]], [[bound-datasets-poc]] (keep-N/pin
retention from #81), [[stage-3-ci-tree-lessons]].
