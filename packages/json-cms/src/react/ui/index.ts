"use client";

// Schema editor family
export { SchemaEditor } from "./schema-editor.js";
export { VisualBuilder } from "./visual-builder.js";
export type { PropertyType, PropertyDef, SchemaFormData } from "./visual-builder.js";
export { ValidationPane } from "./validation-pane.js";
export type { ValidationState, ValidationResult } from "./validation-pane.js";
export { SchemaPreview } from "./schema-preview.js";
export { JsonTree } from "./json-tree.js";

// New batteries-included components
export { EntryForm } from "./entry-form.js";
export type { EntryFormProps } from "./entry-form.js";
export { SchemaList } from "./schema-list.js";
export type { SchemaListProps, SchemaSummary } from "./schema-list.js";

// Primitives
export { Button, buttonVariants } from "./primitives/button.js";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "./primitives/card.js";
export { ConfirmDialog } from "./primitives/dialog.js";
export { Input } from "./primitives/input.js";
export { Label } from "./primitives/label.js";
export { Textarea } from "./primitives/textarea.js";
export { JsonEditor } from "./primitives/json-editor.js";
