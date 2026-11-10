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
});

const stepSchema = z.object({
  index: count,
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

/** The diagnostics of step `index`, if the payload carries it. */
export function stepDiagnosticsOf(
  diagnostics: unknown,
  index: number,
): StepDiagnostics | undefined {
  const parsed = diagnosticsSchema.safeParse(diagnostics);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.steps.find((step) => step.index === index);
}
