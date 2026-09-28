/**
 * The datasets browser's toggle-on merge (roadmap 5a, #99): the server-side
 * default reads never contain lifecycle drafts, so toggled-on merges the
 * opt-in drafts read into the published list for the same downstream
 * filtering/sorting. Toggle-off (or while the drafts read loads) is exactly
 * the published list.
 *
 * Generic over any `{ _id }` row so it stays dependency-free and unit-testable
 * — the route calls it with the convex summaries type, which satisfies the
 * constraint structurally.
 */
export function withDrafts<Row extends { _id: string }>(
  datasets: Row[] | undefined,
  drafts: Row[] | undefined,
  showDrafts: boolean,
): Row[] {
  if (datasets === undefined) {
    return [];
  }
  if (!showDrafts || drafts === undefined) {
    return datasets;
  }
  // The server invariant is that the two reads are disjoint (drafts are
  // filtered out of the default reads); the id guard keeps that invariant
  // observable instead of letting a server-side regression render duplicate
  // cards.
  const publishedIds = new Set(datasets.map((dataset) => dataset._id));
  return [...datasets, ...drafts.filter((draft) => !publishedIds.has(draft._id))];
}
