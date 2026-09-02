"use client";

import type { IChangeEvent } from "@rjsf/core";
import RjsfForm from "@rjsf/shadcn";
import type { UiSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";

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
  /** Called with the submitted form data. */
  onSubmit: (data: unknown) => void | Promise<void>;
}

/**
 * A thin, reusable RJSF form for creating/editing CMS entries against a
 * stored JSON schema. Renders with `@rjsf/shadcn` for styling consistent
 * with the rest of `react/ui`.
 */
export function EntryForm({
  schema,
  uiSchema,
  formData,
  disabled = false,
  submitText = "Submit",
  onSubmit,
}: EntryFormProps) {
  const mergedUiSchema: UiSchema = {
      ...uiSchema,
      "ui:submitButtonOptions": {
        norender: false,
        props: {
          disabled,
        },
        submitText,
      },
    },
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
      onSubmit={handleSubmit}
    />
  );
}
