import { z } from "zod";

/**
 * The diagnostics contract (docs/views-design.md §8) as the preview server
 * function returns it: `{ steps: [...] }`, one entry per compiled step. Read
 * defensively: a malformed payload reads as "no diagnostics", never a crash.
 */

const count = z.coerce.number();
const samples = z.array(z.unknown()).transform((values) => values.map(String));

const joinSchema = z.object({
  leftMatched: count,
  leftUnmatched: count,
  leftUnmatchedSamples: samples,
  rightMatched: count,
  rightUnmatched: count,
  rightUnmatchedSamples: samples,
  multiMatchKeys: count,
  policy: z.string(),
  spread: z
    .object({
      undeclaredCategories: samples,
      undeclaredRows: count,
    })
    .optional(),
});

const stepSchema = z.object({
  index: count,
  /** Set for steps inside a join's sub-pipeline, e.g. `steps[0].right.steps[1]`. */
  path: z.string().optional(),
  kind: z.string(),
  rowsIn: count,
  rowsOut: count,
  fieldsAdded: z.array(z.string()),
  fieldsRemoved: z.array(z.string()),
  join: joinSchema.optional(),
});

const diagnosticsSchema = z.object({ steps: z.array(stepSchema) });

export type JoinDiagnostics = z.infer<typeof joinSchema>;
export type StepDiagnostics = z.infer<typeof stepSchema>;

/**
 * The diagnostics of a step, if the payload carries it. A top-level step is
 * found by `index`; a step inside a sub-pipeline by its `path`
 * (`steps[0].right.steps[1]`), because its `index` is local to the list.
 */
export function stepDiagnosticsOf(
  diagnostics: unknown,
  index: number,
  path?: string,
): StepDiagnostics | undefined {
  const parsed = diagnosticsSchema.safeParse(diagnostics);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.steps.find((step) =>
    path === undefined ? step.path === undefined && step.index === index : step.path === path,
  );
}
