import type { Step } from "@caden/data-core/views";

/**
 * Spatial steps and live views (issue #305; docs/views-design.md §7). A live
 * view computes on every read, and a spatial step (buffer, intersects, ...)
 * would run PostGIS work per read — v1 refuses `live` for any view that has
 * one. No spatial step kind exists yet, so the hook answers false for every
 * current kind; when a spatial kind lands, this is the single place to say
 * so. The predicate is injectable so tests can stand in a stub kind.
 */
export type SpatialStepPredicate = (step: Step) => boolean;

/** True for step kinds that do spatial work. None exist yet in v1. */
export const isSpatialStep: SpatialStepPredicate = (_step) => false;

/** The steps of a (validated) definition that are spatial. */
export function spatialSteps(
  definition: { steps: readonly Step[] },
  isSpatial: SpatialStepPredicate = isSpatialStep,
): Step[] {
  return definition.steps.filter((step) => isSpatial(step));
}

export class LiveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveRefusedError";
  }
}

/** Throws when the definition cannot be a live view. */
export function assertLiveAllowed(
  definition: { steps: readonly Step[] },
  isSpatial: SpatialStepPredicate = isSpatialStep,
): void {
  const spatial = spatialSteps(definition, isSpatial);
  if (spatial.length > 0) {
    const kinds = [...new Set(spatial.map((step) => step.kind))].join(", ");
    throw new LiveRefusedError(
      `A view with spatial steps (${kinds}) can't be live: it would do spatial work on every read. Use manual or auto refresh.`,
    );
  }
}
