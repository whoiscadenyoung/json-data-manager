/**
 * The bound-source paging contract (#127), shared by the source registry
 * (./sources) and every co-deployed reader (./demoSources).
 */

// #127 invariant: the state reader serves ONE PAGE per call and reports its
// continuation — never a truncated prefix dressed up as the whole state.
// finalize's sweep deletes every mapping the run did not see, so callers
// (the sync collect action, the snapshot collector) must drain pages across
// transactions until the null cursor; a collect that fails mid-drain fails
// the run loudly and never reaches the sweep. (Convex allows a single
// paginated query per function execution, so the paging lives across the
// callers' runQuery hops, not inside one transaction.)
export const SOURCE_READ_PAGE = 500;

/**
 * How many commits one `commitsSince` page carries. The sync engine's
 * collect drains the tail page by page until a short page — the page size
 * is the drain signal, so it lives here next to the reader (#127 defect 2).
 */
export const COMMIT_TAIL_PAGE = 500;
