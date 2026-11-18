import { z } from "zod";

/**
 * The diagnostics contract as the preview server function returns it:
 * `{ nodes: [...] }`, one entry per compiled node. Read defensively: a
 * malformed payload reads as "no diagnostics", never a crash.
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

const nodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  rowsIn: count,
  rowsOut: count,
  fieldsAdded: z.array(z.string()),
  fieldsRemoved: z.array(z.string()),
  join: joinSchema.optional(),
});

const diagnosticsSchema = z.object({ nodes: z.array(nodeSchema) });

export type JoinDiagnostics = z.infer<typeof joinSchema>;
export type NodeDiagnostics = z.infer<typeof nodeSchema>;

/** The diagnostics of a node, if the payload carries it. */
export function nodeDiagnosticsOf(diagnostics: unknown, id: string): NodeDiagnostics | undefined {
  const parsed = diagnosticsSchema.safeParse(diagnostics);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.nodes.find((node) => node.id === id);
}
