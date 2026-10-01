import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * Periodic maintenance for bound datasets (docs/bound-datasets-design.md §5):
 * the weekly full reconcile is the drift-repair fallback behind the sync
 * engine's keyed applies — missed commits, out-of-band source edits, or an
 * outage during a run all surface as key drift, which the reconcile pass
 * repairs. The dashboard's sync card can also run one on demand.
 *
 * The abandoned-upload sweep (issue #131): upload URLs the component minted
 * but whose pending-upload rows were never claimed by a consumer are swept
 * daily (the component's TTL is 24h, so a daily pass keeps the table at one
 * TTL's worth of dead rows at most).
 */
const crons = cronJobs();

crons.cron("Weekly reconcile of bound datasets", "0 9 * * 1", internal.sync.reconcileAll, {});

crons.interval("Sweep abandoned uploads", { hours: 24 }, internal.uploads.sweepAbandoned, {});

export default crons;
