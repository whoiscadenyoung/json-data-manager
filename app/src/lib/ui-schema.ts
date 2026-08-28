/**
 * RJSF UiSchema type definitions
 * Based on https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema
 */

/**
 * Options for the submit button
 * @see https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema#submitbuttonoptions
 */
export interface UiSchemaSubmitButtonOptions {
  /** The text of the submit button. Set to "Submit" by default */
  submitText?: string;
  /** Flag, if `true`, removes the submit button completely from the form */
  norender?: boolean;
  /** Any other props to be passed to the submit button itself */
  props?: {
    /** A boolean value stating if the submit button is disabled */
    disabled?: boolean;
    /** The class name for the submit button */
    className?: string;
    [key: string]: unknown;
  };
}

/**
 * Options that can be provided to `ui:options`
 * @see https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema#uioptions
 */
export interface UiOptions {
  /** Label text for the field */
  label?: boolean | string;
  /** Title text for the field */
  title?: string;
  /** Description text for the field */
  description?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Help text */
  help?: string;
  /** Whether the field is disabled */
  disabled?: boolean;
  /** Whether the field is readonly */
  readonly?: boolean;
  /** Whether to hide the error message */
  hideError?: boolean;
  /** Whether to show the label */
  hideLabel?: boolean;
  /** Widget-specific props */
  [key: string]: unknown;
}

/**
 * The UiSchema for a single field or the entire form
 * @see https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema
 */
export interface UiSchema {
  /** Global options that apply to all fields */
  "ui:globalOptions"?: UiOptions;
  /** Submit button configuration */
  "ui:submitButtonOptions"?: UiSchemaSubmitButtonOptions;
  /** Widget to use for this field */
  "ui:widget"?: string;
  /** Field component to use */
  "ui:field"?: string;
  /** Options for the widget/field */
  "ui:options"?: UiOptions;
  /** Whether to autofocus this field */
  "ui:autofocus"?: boolean;
  /** Whether the field is disabled */
  "ui:disabled"?: boolean;
  /** Whether the field is readonly */
  "ui:readonly"?: boolean;
  /** Whether to hide the error message */
  "ui:hideError"?: boolean;
  /** Placeholder text */
  "ui:placeholder"?: string;
  /** Help text */
  "ui:help"?: string;
  /** Title text */
  "ui:title"?: string;
  /** Description text */
  "ui:description"?: string;
  /** Enum names for select/radio options */
  "ui:enumNames"?: string[];
  /** Order of fields (for objects) */
  "ui:order"?: string[];
  /** Whether to enable adding items (for arrays) */
  "ui:addable"?: boolean;
  /** Whether to enable removing items (for arrays) */
  "ui:removable"?: boolean;
  /** Whether to enable ordering items (for arrays) */
  "ui:orderable"?: boolean;
  /** Whether to copy array items */
  "ui:copyable"?: boolean;
  /** Nested UiSchema for object properties */
  [property: string]: unknown;
}

/**
 * Default submit button options
 */
export const DEFAULT_SUBMIT_BUTTON_OPTIONS: UiSchemaSubmitButtonOptions = {
  submitText: "Submit",
  norender: false,
  props: {
    disabled: false,
  },
};

/**
 * Create a default UiSchema with submit button options
 */
export function createDefaultUiSchema(
  options?: Partial<UiSchemaSubmitButtonOptions>
): UiSchema {
  return {
    "ui:submitButtonOptions": {
      ...DEFAULT_SUBMIT_BUTTON_OPTIONS,
      ...options,
    },
  };
}

/**
 * Merge multiple UiSchema objects together
 * Later schemas take precedence
 */
export function mergeUiSchemas(...schemas: (UiSchema | undefined)[]): UiSchema {
  return schemas.reduce<UiSchema>((acc, schema) => {
    if (!schema) return acc;
    return { ...acc, ...schema };
  }, {});
}
