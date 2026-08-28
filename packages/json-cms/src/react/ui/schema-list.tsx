"use client";

import { useSchemas } from "../hooks.js";
import type { SchemaId } from "../../client/index.js";
import { Card, CardHeader, CardTitle, CardDescription } from "./primitives/card.js";

export interface SchemaListProps {
  /** Called with the clicked schema's id. */
  onSelect?: (schemaId: SchemaId) => void;
  /** Message shown when there are no schemas yet. */
  emptyMessage?: string;
}

/**
 * A schema browser driven by the hooks layer's `useSchemas`. Renders a
 * `Card` per schema; pass `onSelect` to react to clicks.
 */
export function SchemaList({ onSelect, emptyMessage = "No schemas yet." }: SchemaListProps) {
  const schemas = useSchemas();

  if (schemas === undefined) {
    return <div className="text-xs text-muted-foreground">Loading schemas…</div>;
  }

  if (schemas.length === 0) {
    return <div className="text-xs text-muted-foreground">{emptyMessage}</div>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {schemas.map((schema) => (
        <Card key={schema._id} className="p-0">
          <button type="button" className="w-full text-left" onClick={() => onSelect?.(schema._id)}>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">{schema.title}</CardTitle>
              <CardDescription className="text-xs">{schema.description}</CardDescription>
            </CardHeader>
          </button>
        </Card>
      ))}
    </div>
  );
}
