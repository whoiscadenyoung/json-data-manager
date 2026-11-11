-- Narrow the kind domains the derived-dataset retirement (0028, #301) left
-- wide (issue #333): 0028 deleted every 'derived' row it named, so the
-- CHECKs no longer need to accept the kind. No backfill needed — the rows
-- are already gone; this only re-issues the constraints.
--
-- map_layers.target_type (0005) keeps its domain on purpose: nothing writes
-- 'derived' any more, but the constraint rides the legacy convex-map seam's
-- retirement, not this cleanup.

alter table public.publish_bundle_members
  drop constraint publish_bundle_members_kind_check;
alter table public.publish_bundle_members
  add constraint publish_bundle_members_kind_check
  check (kind in ('dataset','map'));

alter table public.consumer_references
  drop constraint consumer_references_consumer_kind_check;
alter table public.consumer_references
  add constraint consumer_references_consumer_kind_check
  check (consumer_kind in ('map','fork'));
