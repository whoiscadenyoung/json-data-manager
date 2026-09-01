"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "./primitives/card.js";

/**
 * The minimal shape `SchemaList` needs to render an item. Any object with
 * these fields works — a Convex `SchemaDoc` from `@caden/json-cms/react` is
 * assignable directly.
 */
export interface SchemaSummary {
  _id: string;
  title: string;
  description: string;
}

export interface SchemaListProps {
  /**
   * Schemas to render. Pass `undefined` to show the loading state (e.g. while
   * a query is in flight). This component does no data fetching — fetch the
   * data however you like and pass it in.
   */
  schemas: readonly SchemaSummary[] | undefined;
  /** Called with the clicked schema's id. */
  onSelect?: (schemaId: string) => void;
  /** Message shown when there are no schemas. */
  emptyMessage?: string;
}

/**
 * A backend-agnostic schema browser. Renders a `Card` per schema and calls
 * `onSelect` with the clicked schema's id.
 *
 * It deliberately takes `schemas` as a prop rather than fetching them, so it
 * works with any backend (or none). To wire it to Convex, fetch with the hooks
 * layer and pass the result down:
 *
 * ```tsx
 * import { useSchemas } from "@caden/json-cms/react";
 * import { SchemaList } from "@caden/json-cms/react/ui";
 *
 * const schemas = useSchemas();
 * return <SchemaList schemas={schemas} onSelect={onSelect} />;
 * ```
 */
export function SchemaList({
  schemas,
  onSelect,
  emptyMessage = "No schemas yet.",
}: SchemaListProps) {
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
          <button
            type="button"
            aria-label={`Select ${schema.title}`}
            className="w-full text-left"
            onClick={() => onSelect?.(schema._id)}
          >
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
