import type { FieldType, ValidationError, ViewDefinition } from "@caden/data-core/views";

import type { InputInfo } from "../lib/view-model";

/** What every node form needs from the editor page. */
export interface NodeEditorContext {
  definition: ViewDefinition;
  /** The source nodes' datasets (titles and declared fields). */
  infos: InputInfo[];
  /** The field names each node produces (`undefined` = unknown). */
  fields: ReadonlyMap<string, string[] | undefined>;
  /** Every validation error of the whole definition (paths like `nodes.clean.fields[0].expr`). */
  errors: ValidationError[];
  /** The raw diagnostics payload of the current preview. */
  diagnostics: unknown;
  /** Declared field types across the inputs' json_schema (#335); absent, every expression field checks as "depends on the data". */
  fieldTypes?: ReadonlyMap<string, FieldType>;
}
