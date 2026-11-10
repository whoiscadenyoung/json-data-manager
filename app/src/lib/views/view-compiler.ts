/**
 * The compiler contract the view runner is coded against (issue #300). The
 * real implementation is `@caden/data-core/views` (#299, PR #309); the runner
 * and the preview module take a `ViewCompiler` as an argument so they never
 * import it directly and tests can inject a tiny fake. The one place the real
 * exports are plugged in is `view-compiler-wiring.ts`.
 *
 * The shapes are data-core's own (`@caden/data-core/views`).
 */

import type {
  CompileInputMeta,
  CompiledQuery,
  ValidationError as ValidationIssue,
  ValidationResult,
  ViewDefinition,
} from "@caden/data-core/views";

export type { CompileInputMeta, CompiledQuery, ValidationIssue, ValidationResult, ViewDefinition };

export interface ViewCompiler {
  validateViewDefinition(definition: unknown, inputs?: CompileInputMeta[]): ValidationResult;
  /** SELECT returning `row_id uuid, d jsonb, geom geometry` (geom nullable). */
  compileView(
    definition: ViewDefinition,
    inputs: CompileInputMeta[],
    options?: { uptoStep?: number; limit?: number; unaccent?: boolean },
  ): CompiledQuery;
  /** SELECT returning one row, one column `diagnostics jsonb`. */
  compileDiagnostics(
    definition: ViewDefinition,
    inputs: CompileInputMeta[],
    options?: { uptoStep?: number; unaccent?: boolean },
  ): CompiledQuery;
  viewInputDatasetIds(definition: ViewDefinition, inputs: CompileInputMeta[]): string[];
}

/** One declared input of a view, as stored in `view_inputs`. */
export interface ViewInputRef {
  alias: string;
  datasetId: string;
  pinnedVersion?: string;
}
