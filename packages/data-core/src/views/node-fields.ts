import type { CompileInputMeta, FieldType, ViewDefinition } from "./types.js";
import { GraphScope } from "./validate-fields.js";

/**
 * The fields (name -> type) every node of a definition produces, in `nodes`
 * key order; `undefined` = unknown (a source without field metadata, a
 * bare-`d` sql node, a cycle). The editor offers these in its pickers.
 */
export function nodeFields(
  def: Pick<ViewDefinition, "nodes">,
  metas: CompileInputMeta[],
): Map<string, Map<string, FieldType> | undefined> {
  const scope = new GraphScope(def.nodes, metas);
  return new Map(Object.keys(def.nodes).map((id) => [id, scope.fieldsOf(id)]));
}
