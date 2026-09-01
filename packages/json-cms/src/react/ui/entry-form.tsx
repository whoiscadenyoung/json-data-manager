"use client";

import type { IChangeEvent } from "@rjsf/core";
import Form from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";

import { mergeUiSchemas } from "../lib/ui-schema.js";
import type { UiSchema } from "../lib/ui-schema.js";

export interface EntryFormProps {
  /** JSON Schema describing the entry's shape. */
  schema: object;
  /** Optional RJSF UI schema (e.g. loaded from a `SchemaDoc.uiSchema`). */
  uiSchema?: object;
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
  const mergedUiSchema: UiSchema = mergeUiSchemas(uiSchema as UiSchema | undefined, {
      "ui:submitButtonOptions": {
        norender: false,
        props: {
          disabled,
        },
        submitText,
      },
    }),
    handleSubmit = (data: IChangeEvent) => onSubmit(data.formData);

  return (
    <Form
      schema={schema}
      uiSchema={mergedUiSchema as any}
      validator={validator}
      formData={formData}
      disabled={disabled}
      onSubmit={handleSubmit}
    />
  );
}
