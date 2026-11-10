/**
 * The compiler contract the view runner is coded against (issue #300). The
 * real implementation is `@caden/data-core/views` (#299, PR #309); the runner
 * and the preview module take a `ViewCompiler` as an argument so they never
 * import it directly and tests can inject a tiny fake. The one place the real
 * exports are plugged in is `view-compiler-wiring.ts`.
 *
 * Shapes mirror #299's published signatures. `ViewDefinition` is opaque here
 * (the runner only stores, hashes and forwards it); when #299 is merged the
 * wiring file may narrow it to data-core's type.
 */

export interface CompileInputMeta {
  alias: string;
  datasetId: string;
  title: string;
  pinnedVersion?: string;
  fields?: {
    name: string;
    type?: "string" | "number" | "integer" | "boolean" | "date" | "unknown";
  }[];
}

/** Positional `$1..$n` parameters; casts live in the SQL itself. */
export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** The definition payload as the compiler validated it (opaque to the runner). */
export type ViewDefinition = object;

export type ValidationResult =
  | { ok: true; value: ViewDefinition }
  | { ok: false; errors: ValidationIssue[] };

export interface ViewCompiler {
  validateViewDefinition(definition: unknown, inputs?: CompileInputMeta[]): ValidationResult;
  /** SELECT returning `row_id uuid, d jsonb, geom geometry` (geom nullable). */
  compileView(
    definition: ViewDefinition,
    inputs: CompileInputMeta[],
    options?: { uptoStep?: number; limit?: number },
  ): CompiledQuery;
  /** SELECT returning one row, one column `diagnostics jsonb`. */
  compileDiagnostics(
    definition: ViewDefinition,
    inputs: CompileInputMeta[],
    options?: { uptoStep?: number },
  ): CompiledQuery;
  viewInputDatasetIds(definition: ViewDefinition, inputs: CompileInputMeta[]): string[];
}

/** One declared input of a view, as stored in `view_inputs`. */
export interface ViewInputRef {
  alias: string;
  datasetId: string;
  pinnedVersion?: string;
}
