# Task: Create Headless React Components

Create three headless React components for the `@convex-json/react` package. These components should be unstyled (headless) and provide flexible APIs for building schema editors and data entry forms.

## Files to Create

1. `packages/json-data-manager/src/components/SchemaEditor.tsx`
2. `packages/json-data-manager/src/components/EntryForm.tsx`
3. `packages/json-data-manager/src/components/ValidationPane.tsx`

---

## 1. SchemaEditor Component

A headless schema editor using the render prop pattern. This component manages the internal state for schema JSON editing (both visual and code modes) and exposes the UI structure via render props.

### Interface

```tsx
import type { ReactNode } from "react";

export interface ValidationState {
  total: number;
  failingPaths: Map<string, number>; // path -> count of failing items
}

export interface SchemaEditorRenderProps {
  // State
  schemaJson: string;
  activeTab: "visual" | "code";
  isSaving: boolean;
  canSave: boolean;
  parseError: string | null;
  isOverLimit: boolean;
  schemaBytes: number;
  sizeLimit: number;

  // Validation pane state (lifted for visual builder badges)
  validationState: ValidationState;

  // Actions
  setSchemaJson: (json: string) => void;
  setActiveTab: (tab: "visual" | "code") => void;
  handleSave: () => Promise<void>;

  // Drag & drop file handling
  isDraggingFile: boolean;
  getRootProps: () => {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };

  // File input handling
  getInputProps: () => {
    type: "file";
    accept: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    style: { display: "none" };
  };

  // Confirmation dialog state (for file replace/infer)
  pendingFile: { file: File; content: string; isDataArray: boolean } | null;
  isConfirmDialogOpen: boolean;
  setIsConfirmDialogOpen: (open: boolean) => void;
  handleConfirm: () => void;
}

export interface SchemaEditorProps {
  initialJson?: string;
  onSave: (json: string, parsed: object) => Promise<void>;
  sizeLimit?: number; // default: 102400 (100 KB)
  children: (props: SchemaEditorRenderProps) => ReactNode;
}

export function SchemaEditor(props: SchemaEditorProps): ReactNode;
```

### Implementation Notes

- Reference existing implementation in `src/components/schema-editor/schema-editor.tsx`
- Keep drag-and-drop logic internal (document-level events for full-page overlay)
- Parse validation: require object with non-empty `title` and `description`
- File drop handling: detect schema object vs data array via `Array.isArray()`
- When data array dropped with existing schema, offer to load into validation pane
- When data array dropped without schema, infer schema using `inferSchemaFromData()`
- Use `selfChangedRef` pattern to prevent re-parsing when visual builder updates JSON

---

## 2. EntryForm Component

A headless wrapper around `@rjsf/core` that renders a form based on a JSON Schema. This component is intentionally thin - it mostly passes through to RJSF but provides a consistent interface.

### Interface

```tsx
import type { ReactNode } from "react";
import type { FormProps as RJSFFormProps } from "@rjsf/core";
import type { RJSFSchema } from "@rjsf/utils";
import type { IChangeEvent } from "@rjsf/core";

export interface EntryFormProps<T = unknown> {
  schema: RJSFSchema;
  uiSchema?: RJSFFormProps<T>["uiSchema"];
  formData?: T;
  onSubmit?: (data: IChangeEvent<T>) => void | Promise<void>;
  onChange?: (data: IChangeEvent<T>) => void;
  onError?: (errors: unknown[]) => void;
  disabled?: boolean;
  readonly?: boolean;
  /**
   * The RJSF Form component to use. This allows consumers to pass
   * their themed version (e.g., @rjsf/shadcn, @rjsf/mui, etc.)
   */
  formComponent: React.ComponentType<RJSFFormProps<T>>;
  /**
   * The validator to use. Typically from @rjsf/validator-ajv8
   */
  validator: RJSFFormProps<T>["validator"];
  /**
   * Additional props to pass through to the underlying Form component
   */
  formProps?: Omit<RJSFFormProps<T>, "schema" | "uiSchema" | "formData" | "onSubmit" | "onChange" | "onError" | "validator" | "disabled" | "readonly">;
}

export function EntryForm<T = unknown>(props: EntryFormProps<T>): ReactNode;
```

### Implementation Notes

- This is a thin wrapper that delegates to the provided `formComponent`
- The consumer must provide their themed RJSF Form component (e.g., `@rjsf/shadcn`)
- The consumer must provide the validator (e.g., `validator-ajv8`)
- Reference existing usage in `src/routes/schemas/$schemaId/create.tsx`

### Usage Example

```tsx
import { EntryForm } from "@convex-json/react";
import Form from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";

function MyPage() {
  return (
    <EntryForm
      schema={mySchema}
      formComponent={Form}
      validator={validator}
      onSubmit={handleSubmit}
      uiSchema={{
        "ui:submitButtonOptions": {
          submitText: "Create Entry",
        },
      }}
    />
  );
}
```

---

## 3. ValidationPane Component

A headless component for validating JSON data against a schema. Provides validation results via render props.

### Interface

```tsx
import type { ReactNode } from "react";

export interface ValidationResult {
  index: number;
  data: unknown;
  valid: boolean;
  failingPaths: Set<string>;
  errors: Map<string, string>; // path -> error message
  unknownPaths: Set<string>; // paths in data not in schema
}

export interface ValidationPaneRenderProps {
  // Data input
  dataText: string;
  setDataText: (text: string) => void;
  fileName: string | null;

  // Actions
  loadFile: (file: File) => void;
  clearData: () => void;

  // Drag & drop
  isDragging: boolean;
  getDropzoneProps: () => {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  getFileInputProps: () => {
    type: "file";
    accept: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    style: { display: "none" };
  };

  // Results
  results: ValidationResult[] | null;
  parseError: string | null;
  validCount: number;
  hasData: boolean;

  // Item expansion (for UI that shows collapsible items)
  expandedItems: Set<number>;
  toggleExpanded: (index: number) => void;

  // Schema inference
  inferSchema: () => void;
  isInferConfirmOpen: boolean;
  setIsInferConfirmOpen: (open: boolean) => void;

  // For CodeMirror schema linting
  arrayJsonSchema: object | undefined; // { type: "array", items: schema }
}

export interface ValidationPaneProps {
  schemaJson: string;
  /** Optional externally provided data (e.g., from parent drop) */
  externalDataText?: { text: string };
  onInferSchema?: (inferredJson: string) => void;
  onStateChange?: (state: { total: number; failingPaths: Map<string, number> }) => void;
  children: (props: ValidationPaneRenderProps) => ReactNode;
}

export function ValidationPane(props: ValidationPaneProps): ReactNode;
```

### Implementation Notes

- Reference existing implementation in `src/components/schema-editor/validation-pane.tsx`
- Use `@rjsf/validator-ajv8` for validation: `validator.validateFormData(item, schema)`
- Error path conversion: RJSF `err.property` is JS accessor notation (`.email`, `.address.city`)
  - Convert: `err.property.replace(/^\./, "")` then prepend `/`
  - For required errors: use `err.params.missingProperty` to get the key
- `computeUnknownPaths`: recursively find data properties not defined in schema
- `arrayJsonSchema`: wrap the parsed schema in `{ type: "array", items: schema }` for CodeMirror linting
- Validate on every change to `schemaJson` or `dataText` using `useEffect`

---

## Shared Utilities

Create these utility functions in `packages/json-data-manager/src/lib/`:

### `infer-schema.ts`

```tsx
export function inferSchemaFromData(data: unknown[]): object {
  // Infer a JSON Schema from an array of data objects
  // Reference: src/lib/infer-schema.ts in the main app
}
```

### `validation.ts`

```tsx
/**
 * Convert RJSF validation error property to JSON Pointer path
 * ".email" -> "/email"
 * ".address.city" -> "/address/city"
 */
export function rjsfPropertyToPath(property: string): string;

/**
 * Compute unknown paths in data that are not defined in schema
 */
export function computeUnknownPaths(
  data: unknown,
  schema: Record<string, unknown>,
  pathPrefix?: string
): Set<string>;
```

---

## Patterns from Existing Code

### Schema Editor State Management

```tsx
// Use ref to prevent re-parsing when we triggered the change
const selfChangedRef = useRef(false);

useEffect(() => {
  if (selfChangedRef.current) {
    selfChangedRef.current = false;
    return;
  }
  // Parse incoming JSON
}, [schemaJson]);

const handleFormChange = useCallback((updated: SchemaFormData) => {
  selfChangedRef.current = true;
  setFormData(updated);
  onChange(schemaFormDataToJson(updated));
}, [onChange]);
```

### Validation Error Path Handling

```tsx
for (const err of errors) {
  let path: string | null = null;

  if (err.name === "required" && err.params?.missingProperty) {
    path = `/${err.params.missingProperty}`;
  } else if (err.property && err.property !== ".") {
    const raw = err.property.replace(/^\./, "");
    path = raw.startsWith("/") ? raw : `/${raw}`;
  }

  if (path) {
    failingPaths.add(path);
    errorMessages.set(path, err.message);
  }
}
```

### Drag and Drop Handling

```tsx
// Document-level events for full-page overlay
useEffect(() => {
  const onDragEnter = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) {
      setIsDraggingFile(true);
    }
  };
  // ... other handlers

  document.addEventListener("dragenter", onDragEnter);
  return () => document.removeEventListener("dragenter", onDragEnter);
}, []);
```

---

## Dependencies

```json
{
  "dependencies": {
    "@rjsf/core": "^5.x",
    "@rjsf/utils": "^5.x",
    "@rjsf/validator-ajv8": "^5.x",
    "react": "^18.x || ^19.x"
  },
  "peerDependencies": {
    "@rjsf/core": "^5.x",
    "react": "^18.x || ^19.x"
  }
}
```

---

## Acceptance Criteria

- [ ] `SchemaEditor` exports headless component with render props
- [ ] `EntryForm` exports thin wrapper around RJSF with injectable Form component
- [ ] `ValidationPane` exports headless component with validation results via render props
- [ ] All components are fully typed with TypeScript
- [ ] No UI styling imported (consumers provide all styling)
- [ ] Utilities (`inferSchemaFromData`, `computeUnknownPaths`) exported from `lib/`
- [ ] Components work with React 18 and 19
