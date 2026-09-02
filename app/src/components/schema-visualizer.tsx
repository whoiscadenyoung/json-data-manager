import { CheckSquare, ChevronDown, ChevronRight, Square } from "lucide-react";
import { useState } from "react";

import type { JsonSchemaNode, ParsedProperty } from "#/lib/json-schema";
import { parseSchemaProperties } from "#/lib/json-schema";
import { cn } from "#/lib/utils";

/** A read-only stand-in for an <Input>/<select> box in the create-time schema builder. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 min-w-0 items-center truncate rounded-md border border-input bg-background px-1.5 text-xs">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function FlagIndicator({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs",
        on ? "text-foreground" : "text-muted-foreground/50",
      )}
    >
      {on ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
      {label}
    </span>
  );
}

function StringDetails({ prop }: { prop: ParsedProperty }) {
  const hasRange = prop.minLength !== undefined || prop.maxLength !== undefined;
  return (
    <>
      {(prop.format || prop.pattern || hasRange) && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {prop.format && (
            <Field label="Format">
              <Chip>{prop.format}</Chip>
            </Field>
          )}
          {prop.pattern && (
            <Field label="Pattern">
              <Chip>{prop.pattern}</Chip>
            </Field>
          )}
          {prop.minLength !== undefined && (
            <Field label="Min length">
              <Chip>{prop.minLength}</Chip>
            </Field>
          )}
          {prop.maxLength !== undefined && (
            <Field label="Max length">
              <Chip>{prop.maxLength}</Chip>
            </Field>
          )}
        </div>
      )}
      {prop.enumValues && (
        <Field label="Enum values">
          <Chip>{prop.enumValues.map((v) => String(v)).join(", ")}</Chip>
        </Field>
      )}
    </>
  );
}

function NumberDetails({ prop }: { prop: ParsedProperty }) {
  const hasRange =
    prop.minimum !== undefined || prop.maximum !== undefined || prop.multipleOf !== undefined;
  return (
    <>
      {hasRange && (
        <div className="grid grid-cols-3 gap-2">
          {prop.minimum !== undefined && (
            <Field label="Minimum">
              <Chip>{prop.minimum}</Chip>
            </Field>
          )}
          {prop.maximum !== undefined && (
            <Field label="Maximum">
              <Chip>{prop.maximum}</Chip>
            </Field>
          )}
          {prop.multipleOf !== undefined && (
            <Field label="Multiple of">
              <Chip>{prop.multipleOf}</Chip>
            </Field>
          )}
        </div>
      )}
      {prop.enumValues && (
        <Field label="Enum values">
          <Chip>{prop.enumValues.map((v) => String(v)).join(", ")}</Chip>
        </Field>
      )}
    </>
  );
}

function ArrayDetails({ prop }: { prop: ParsedProperty }) {
  const hasRange = prop.minItems !== undefined || prop.maxItems !== undefined;
  return (
    <>
      {(prop.itemType || hasRange) && (
        <div className="grid grid-cols-3 gap-2">
          {prop.itemType && (
            <Field label="Item type">
              <Chip>{prop.itemType}</Chip>
            </Field>
          )}
          {prop.minItems !== undefined && (
            <Field label="Min items">
              <Chip>{prop.minItems}</Chip>
            </Field>
          )}
          {prop.maxItems !== undefined && (
            <Field label="Max items">
              <Chip>{prop.maxItems}</Chip>
            </Field>
          )}
        </div>
      )}
      {prop.itemType === "object" && prop.properties && (
        <div className="space-y-1.5 border-t border-border pt-2">
          <p className="text-xs text-muted-foreground">Item object schema</p>
          <div className="space-y-1.5 border-l border-border pl-2">
            {prop.properties.map((child) => (
              <PropertyRow key={child.name} prop={child} depth={1} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Whether this field has anything worth expanding for. */
function hasDetails(prop: ParsedProperty): boolean {
  return [
    prop.title,
    prop.description,
    prop.format,
    prop.pattern,
    prop.minLength !== undefined,
    prop.maxLength !== undefined,
    prop.minimum !== undefined,
    prop.maximum !== undefined,
    prop.multipleOf !== undefined,
    prop.enumValues,
    prop.itemType,
    prop.minItems !== undefined,
    prop.maxItems !== undefined,
    prop.properties && prop.properties.length > 0,
  ].some(Boolean);
}

function TitleAndDescription({ prop }: { prop: ParsedProperty }) {
  if (!prop.title && !prop.description) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {prop.title && (
        <Field label="Title">
          <Chip>{prop.title}</Chip>
        </Field>
      )}
      {prop.description && (
        <Field label="Description">
          <Chip>{prop.description}</Chip>
        </Field>
      )}
    </div>
  );
}

function PropertyDetails({ prop, depth }: { prop: ParsedProperty; depth: number }) {
  if (!hasDetails(prop)) {
    return (
      <div className="border-t border-border px-3 py-3">
        <p className="text-xs italic text-muted-foreground">
          No additional options are set for this field.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-border px-3 pb-3 pt-3">
      <TitleAndDescription prop={prop} />

      {(prop.type === "string" || prop.type === "any") && <StringDetails prop={prop} />}
      {(prop.type === "number" || prop.type === "integer") && <NumberDetails prop={prop} />}
      {prop.type === "array" && <ArrayDetails prop={prop} />}

      {prop.type === "object" && prop.properties && (
        <div className="space-y-1.5 border-l border-border pl-2">
          {prop.properties.map((child) => (
            <PropertyRow key={child.name} prop={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function PropertyRowHeader({
  prop,
  expanded,
  onToggle,
}: {
  prop: ParsedProperty;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>

      <span className="min-w-0 flex-1 truncate font-mono text-xs">{prop.name}</span>

      <Chip>{prop.type}</Chip>

      <FlagIndicator label="req" on={prop.required} />
      <FlagIndicator label="null" on={prop.nullable} />
    </div>
  );
}

function PropertyRow({ prop, depth = 0 }: { prop: ParsedProperty; depth?: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("rounded-md border border-border bg-card", depth > 0 && "bg-muted/30")}>
      <PropertyRowHeader
        prop={prop}
        expanded={expanded}
        onToggle={() => {
          setExpanded(!expanded);
        }}
      />
      {expanded && <PropertyDetails prop={prop} depth={depth} />}
    </div>
  );
}

/**
 * A read-only mirror of the create/edit visual schema builder: the same
 * bordered property rows, type box, and expandable detail panel, without
 * any inputs — just the resolved values.
 */
export function SchemaVisualizer({ schema }: { schema: JsonSchemaNode }) {
  const properties = parseSchemaProperties(schema.properties, schema.required);

  if (properties.length === 0) {
    return <p className="text-sm text-muted-foreground">This schema has no fields defined.</p>;
  }

  return (
    <div className="space-y-1.5">
      {properties.map((prop) => (
        <PropertyRow key={prop.name} prop={prop} />
      ))}
    </div>
  );
}
