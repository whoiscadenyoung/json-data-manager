import { getReferenceFields } from "../../shared/reference.js";
import type { ReferenceCandidate } from "../../shared/reference.js";

export type { ReferenceCandidate } from "../../shared/reference.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns a target dataset's entries into a reference field's candidate list,
 * labeling each by `displayProperty` (falling back to the raw entry id when
 * the field is unset, or the target entry doesn't have that property).
 */
export function buildReferenceCandidates(
  entries: ReadonlyArray<{ _id: string; data: unknown }>,
  displayProperty: string | undefined,
): ReferenceCandidate[] {
  return entries.map((entry) => {
    const data = entry.data,
      raw = displayProperty && isRecord(data) ? data[displayProperty] : undefined;
    return {
      label: typeof raw === "string" && raw.length > 0 ? raw : entry._id,
      value: entry._id,
    };
  });
}

/**
 * Builds the `uiSchema` fragment that wires every one of `schema`'s
 * reference fields (see ../../shared/reference.ts) to the `"reference"`
 * widget, carrying each field's candidate list and cardinality through
 * `ui:options`. Merge the result into the form's own `uiSchema` and pass
 * `widgets={{ reference: ReferenceWidget }}` to the RJSF form.
 */
export function buildReferenceUiSchema(
  schema: unknown,
  candidatesByField: Record<string, ReferenceCandidate[]>,
): Record<string, unknown> {
  const ui: Record<string, unknown> = {};
  for (const field of getReferenceFields(schema)) {
    ui[field.name] = {
      "ui:options": {
        candidates: candidatesByField[field.name] ?? [],
        cardinality: field.meta.cardinality,
      },
      "ui:widget": "reference",
    };
  }
  return ui;
}
