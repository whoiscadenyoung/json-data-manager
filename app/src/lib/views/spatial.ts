import type { ViewNode } from "@caden/data-core/views";

/**
 * Spatial nodes and live views (issue #305; docs/views-design.md §7). A live
 * view computes on every read, and a spatial node (buffer, intersects, ...)
 * would run PostGIS work per read — v1 refuses `live` for any view that has
 * one. No spatial node kind exists yet, so the hook answers false for every
 * current kind; when a spatial kind lands, this is the single place to say
 * so. The predicate is injectable so tests can stand in a stub kind.
 */
export type SpatialStepPredicate = (node: ViewNode) => boolean;

/** True for node kinds that do spatial work. None exist yet in v1. */
export const isSpatialStep: SpatialStepPredicate = (_node) => false;

/** The nodes of a (validated) definition that are spatial. */
export function spatialSteps(
  definition: { nodes: Record<string, ViewNode> },
  isSpatial: SpatialStepPredicate = isSpatialStep,
): ViewNode[] {
  return Object.values(definition.nodes).filter((node) => isSpatial(node));
}

export class LiveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveRefusedError";
  }
}

/** Throws when the definition cannot be a live view. */
export function assertLiveAllowed(
  definition: { nodes: Record<string, ViewNode> },
  isSpatial: SpatialStepPredicate = isSpatialStep,
): void {
  const spatial = spatialSteps(definition, isSpatial);
  if (spatial.length > 0) {
    const kinds = [...new Set(spatial.map((step) => step.kind))].join(", ");
    throw new LiveRefusedError(
      `A view with spatial nodes (${kinds}) can't be live: it would do spatial work on every read. Use manual or auto refresh.`,
    );
  }
}
