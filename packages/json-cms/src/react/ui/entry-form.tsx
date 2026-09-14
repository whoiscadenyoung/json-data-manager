"use client";

import type { IChangeEvent } from "@rjsf/core";
import RjsfForm from "@rjsf/shadcn";
import type { UiSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";

import type { ReferenceCandidate } from "../../shared/reference.js";
import { buildReferenceUiSchema } from "../lib/reference-ui-schema.js";
import { ReferenceWidget } from "./reference-widget.js";

// Stable empty-object reference for the `referenceCandidates` prop's
// default — a fresh `{}` literal on every render would break referential
// equality for consumers that don't pass their own.
const EMPTY_REFERENCE_CANDIDATES: Record<string, ReferenceCandidate[]> = {};

export interface EntryFormProps {
  /** JSON Schema describing the entry's shape. */
  schema: object;
  /** Optional RJSF UI schema (e.g. loaded from a `SchemaDoc.uiSchema`). */
  uiSchema?: UiSchema;
  /** Initial/controlled form data. */
  formData?: unknown;
  /** Disables all fields and the submit button, e.g. while saving. */
  disabled?: boolean;
  /** Label for the submit button. Defaults to "Submit". */
  submitText?: string;
  /**
   * Candidate entries for each of `schema`'s reference fields (see
   * ../../shared/reference.ts), keyed by field name — build with
   * `buildReferenceCandidates` from `../lib/reference-ui-schema.js` against
   * each target dataset's entries. A reference field with no entry here (or
   * an empty candidate list) renders as "No entries in the target dataset
   * yet."
   */
  referenceCandidates?: Record<string, ReferenceCandidate[]>;
  /** Called with the submitted form data. */
  onSubmit: (data: unknown) => void | Promise<void>;
}

/**
 * A thin, reusable RJSF form for creating/editing CMS entries against a
 * stored JSON schema. Renders with `@rjsf/shadcn` for styling consistent
 * with the rest of `react/ui`. Reference fields (see ../../shared/reference.ts)
 * render as a picker automatically — pass `referenceCandidates` to populate it.
 */
export function EntryForm({
  schema,
  uiSchema,
  formData,
  disabled = false,
  submitText = "Submit",
  referenceCandidates = EMPTY_REFERENCE_CANDIDATES,
  onSubmit,
}: EntryFormProps) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `buildReferenceUiSchema`'s return is deliberately untyped (a plain per-field record) to avoid conflicting with @rjsf/utils's own `UiSchema` shape when spread together; the runtime shape (a `ui:widget`/`ui:options` pair per reference field name) is exactly what RJSF expects there.
  const mergedUiSchema = {
      ...buildReferenceUiSchema(schema, referenceCandidates),
      ...uiSchema,
      "ui:submitButtonOptions": {
        norender: false,
        props: {
          disabled,
        },
        submitText,
      },
    } as UiSchema,
    handleSubmit = (data: IChangeEvent): void => {
      void onSubmit(data.formData);
    };

  return (
    <RjsfForm
      schema={schema}
      uiSchema={mergedUiSchema}
      validator={validator}
      formData={formData}
      disabled={disabled}
      widgets={{ reference: ReferenceWidget }}
      onSubmit={handleSubmit}
    />
  );
}
