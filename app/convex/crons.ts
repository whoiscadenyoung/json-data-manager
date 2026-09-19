import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * Periodic maintenance for bound datasets (docs/bound-datasets-design.md §5):
 * the weekly full reconcile is the drift-repair fallback behind the sync
 * engine's keyed applies — missed commits, out-of-band source edits, or an
 * outage during a run all surface as key drift, which the reconcile pass
 * repairs. The dashboard's sync card can also run one on demand.
 */
const crons = cronJobs();

crons.cron("Weekly reconcile of bound datasets", "0 9 * * 1", internal.sync.reconcileAll, {});

export default crons;
