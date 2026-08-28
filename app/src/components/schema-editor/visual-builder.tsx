import { useState, useEffect, useCallback, useRef } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PropertyType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  title: string;
  description: string;
  required: boolean;
  // string
  format: string;
  minLength: string;
  maxLength: string;
  pattern: string;
  enum: string;
  // number/integer
  minimum: string;
  maximum: string;
  multipleOf: string;
  // array
  itemType: string;
  minItems: string;
  maxItems: string;
  itemSchema: PropertyDef | null; // For array of objects
  // object
  properties: PropertyDef[];
}

export interface SchemaFormData {
  title: string;
  description: string;
  properties: PropertyDef[];
}

// ─── Serialization ───────────────────────────────────────────────────────────

function makePropertySchema(prop: PropertyDef): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  schema.type = prop.type;
  if (prop.title) schema.title = prop.title;
  if (prop.description) schema.description = prop.description;

  if (prop.type === "string") {
    if (prop.format) schema.format = prop.format;
    if (prop.minLength !== "") schema.minLength = Number(prop.minLength);
    if (prop.maxLength !== "") schema.maxLength = Number(prop.maxLength);
    if (prop.pattern) schema.pattern = prop.pattern;
    if (prop.enum.trim()) {
      schema.enum = prop.enum
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  if (prop.type === "number" || prop.type === "integer") {
    if (prop.minimum !== "") schema.minimum = Number(prop.minimum);
    if (prop.maximum !== "") schema.maximum = Number(prop.maximum);
    if (prop.multipleOf !== "") schema.multipleOf = Number(prop.multipleOf);
    if (prop.enum.trim()) {
      schema.enum = prop.enum
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
    }
  }

  if (prop.type === "array") {
    if (prop.itemType) {
      if (prop.itemType === "object" && prop.itemSchema) {
        // Array of objects with defined schema
        schema.items = makePropertySchema(prop.itemSchema);
        delete (schema.items as Record<string, unknown>).name;
        delete (schema.items as Record<string, unknown>).required;
      } else {
        // Array of primitives
        schema.items = { type: prop.itemType };
      }
    }
    if (prop.minItems !== "") schema.minItems = Number(prop.minItems);
    if (prop.maxItems !== "") schema.maxItems = Number(prop.maxItems);
  }

  if (prop.type === "object" && prop.properties.length > 0) {
    const nestedProps: Record<string, unknown> = {};
    const nestedRequired: string[] = [];
    for (const child of prop.properties) {
      nestedProps[child.name] = makePropertySchema(child);
      if (child.required) nestedRequired.push(child.name);
    }
    schema.properties = nestedProps;
    if (nestedRequired.length > 0) schema.required = nestedRequired;
  }

  return schema;
}

export function schemaFormDataToJson(data: SchemaFormData): string {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const prop of data.properties) {
    if (!prop.name.trim()) continue;
    properties[prop.name] = makePropertySchema(prop);
    if (prop.required) required.push(prop.name);
  }

  const schema: Record<string, unknown> = {
    type: "object",
    title: data.title,
    description: data.description,
    properties,
  };
  if (required.length > 0) schema.required = required;

  return JSON.stringify(schema, null, 2);
}

// ─── Deserialization ──────────────────────────────────────────────────────────

let propIdCounter = 0;
function nextId() {
  return `prop_${++propIdCounter}`;
}

function parsePropertyDef(
  name: string,
  schema: Record<string, unknown>,
  requiredSet: Set<string>,
): PropertyDef {
  const type = (schema.type as PropertyType) ?? "string";
  const enumVals = Array.isArray(schema.enum)
    ? (schema.enum as unknown[]).map(String).join(", ")
    : "";

  const prop: PropertyDef = {
    id: nextId(),
    name,
    type,
    title: (schema.title as string) ?? "",
    description: (schema.description as string) ?? "",
    required: requiredSet.has(name),
    format: (schema.format as string) ?? "",
    minLength: schema.minLength !== undefined ? String(schema.minLength) : "",
    maxLength: schema.maxLength !== undefined ? String(schema.maxLength) : "",
    pattern: (schema.pattern as string) ?? "",
    enum: enumVals,
    minimum: schema.minimum !== undefined ? String(schema.minimum) : "",
    maximum: schema.maximum !== undefined ? String(schema.maximum) : "",
    multipleOf: schema.multipleOf !== undefined ? String(schema.multipleOf) : "",
    itemType:
      typeof schema.items === "object" && schema.items !== null
        ? (((schema.items as Record<string, unknown>).type as string) ?? "")
        : "",
    minItems: schema.minItems !== undefined ? String(schema.minItems) : "",
    maxItems: schema.maxItems !== undefined ? String(schema.maxItems) : "",
    itemSchema: null,
    properties: [],
  };

  if (type === "object" && typeof schema.properties === "object" && schema.properties !== null) {
    const nestedRequired = new Set<string>(
      Array.isArray(schema.required) ? (schema.required as string[]) : [],
    );
    prop.properties = Object.entries(schema.properties as Record<string, unknown>).map(([k, v]) =>
      parsePropertyDef(k, v as Record<string, unknown>, nestedRequired),
    );
  }

  // Parse array item schema for object arrays
  if (type === "array" && prop.itemType === "object" && typeof schema.items === "object" && schema.items !== null) {
    const itemsSchema = schema.items as Record<string, unknown>;
    if (itemsSchema.type === "object") {
      prop.itemSchema = parsePropertyDef("item", itemsSchema, new Set());
    }
  }

  return prop;
}

export function jsonToSchemaFormData(json: string): SchemaFormData | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const requiredSet = new Set<string>(
      Array.isArray(obj.required) ? (obj.required as string[]) : [],
    );
    const properties =
      typeof obj.properties === "object" && obj.properties !== null
        ? Object.entries(obj.properties as Record<string, unknown>).map(([k, v]) =>
            parsePropertyDef(k, v as Record<string, unknown>, requiredSet),
          )
        : [];
    return {
      title: (obj.title as string) ?? "",
      description: (obj.description as string) ?? "",
      properties,
    };
  } catch {
    return null;
  }
}

// ─── Default property ─────────────────────────────────────────────────────────

function defaultProp(): PropertyDef {
  return {
    id: nextId(),
    name: "",
    type: "string",
    title: "",
    description: "",
    required: false,
    format: "",
    minLength: "",
    maxLength: "",
    pattern: "",
    enum: "",
    minimum: "",
    maximum: "",
    multipleOf: "",
    itemType: "",
    minItems: "",
    maxItems: "",
    itemSchema: null,
    properties: [],
  };
}

// ─── PropertyRow ──────────────────────────────────────────────────────────────

const STRING_FORMATS = ["", "email", "uri", "date", "date-time", "time", "password", "hostname"];
const PROPERTY_TYPES: PropertyType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
];

function PropertyRow({
  prop,
  onChange,
  onRemove,
  failingCount,
  totalDataItems,
  depth = 0,
}: {
  prop: PropertyDef;
  onChange: (updated: PropertyDef) => void;
  onRemove: () => void;
  failingCount: number;
  totalDataItems: number;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const set = <K extends keyof PropertyDef>(key: K, value: PropertyDef[K]) =>
    onChange({ ...prop, [key]: value });

  const hasFailures = failingCount > 0;

  return (
    <div className={cn("rounded-md border border-border bg-card", depth > 0 && "bg-muted/30")}>
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground flex-shrink-0"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Property name */}
        <Input
          value={prop.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="property_name"
          className="h-6 text-xs font-mono flex-1 min-w-0"
        />

        {/* Type selector */}
        <select
          value={prop.type}
          onChange={(e) => set("type", e.target.value as PropertyType)}
          className={cn(
            "h-6 rounded-md border border-input bg-background px-1.5 text-xs",
            "focus:outline-none focus:ring-1 focus:ring-ring",
            "shrink-0",
          )}
        >
          {PROPERTY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        {/* Required toggle */}
        <label className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={prop.required}
            onChange={(e) => set("required", e.target.checked)}
            className="h-3 w-3 rounded"
          />
          req
        </label>

        {/* Failing badge */}
        {totalDataItems > 0 && (
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0",
              hasFailures
                ? "bg-destructive/15 text-destructive"
                : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
            )}
          >
            {hasFailures ? `${failingCount}/${totalDataItems} fail` : `${totalDataItems} pass`}
          </span>
        )}

        {/* Remove */}
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive flex-shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Expanded: advanced options */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Title</Label>
              <Input
                value={prop.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Display name"
                className="h-6 text-xs"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Description</Label>
              <Input
                value={prop.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Field description"
                className="h-6 text-xs"
              />
            </div>
          </div>

          {/* String-specific */}
          {prop.type === "string" && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Format</Label>
                  <select
                    value={prop.format}
                    onChange={(e) => set("format", e.target.value)}
                    className="w-full h-6 rounded-md border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {STRING_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f || "(none)"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Pattern (regex)</Label>
                  <Input
                    value={prop.pattern}
                    onChange={(e) => set("pattern", e.target.value)}
                    placeholder="^[a-z]+$"
                    className="h-6 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Min length</Label>
                  <Input
                    type="number"
                    min={0}
                    value={prop.minLength}
                    onChange={(e) => set("minLength", e.target.value)}
                    placeholder="0"
                    className="h-6 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Max length</Label>
                  <Input
                    type="number"
                    min={0}
                    value={prop.maxLength}
                    onChange={(e) => set("maxLength", e.target.value)}
                    placeholder="∞"
                    className="h-6 text-xs"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Enum values (comma-separated)</Label>
                <Input
                  value={prop.enum}
                  onChange={(e) => set("enum", e.target.value)}
                  placeholder="option1, option2, option3"
                  className="h-6 text-xs"
                />
              </div>
            </div>
          )}

          {/* Number/integer-specific */}
          {(prop.type === "number" || prop.type === "integer") && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Minimum</Label>
                  <Input
                    type="number"
                    value={prop.minimum}
                    onChange={(e) => set("minimum", e.target.value)}
                    placeholder="−∞"
                    className="h-6 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Maximum</Label>
                  <Input
                    type="number"
                    value={prop.maximum}
                    onChange={(e) => set("maximum", e.target.value)}
                    placeholder="+∞"
                    className="h-6 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Multiple of</Label>
                  <Input
                    type="number"
                    min={0}
                    value={prop.multipleOf}
                    onChange={(e) => set("multipleOf", e.target.value)}
                    placeholder="—"
                    className="h-6 text-xs"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Enum values (comma-separated numbers)</Label>
                <Input
                  value={prop.enum}
                  onChange={(e) => set("enum", e.target.value)}
                  placeholder="1, 2, 3"
                  className="h-6 text-xs"
                />
              </div>
            </div>
          )}

          {/* Array-specific */}
          {prop.type === "array" && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Item type</Label>
                  <select
                    value={prop.itemType}
                    onChange={(e) => {
                      const newType = e.target.value;
                      set("itemType", newType);
                      // Initialize itemSchema when switching to object type
                      if (newType === "object" && !prop.itemSchema) {
                        set("itemSchema", { ...defaultProp(), type: "object" });
                      }
                    }}
                    className="w-full h-6 rounded-md border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">(any)</option>
                    {PROPERTY_TYPES.filter((t) => t !== "array").map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Min items</Label>
                  <Input
                    type="number"
                    min={0}
                    value={prop.minItems}
                    onChange={(e) => set("minItems", e.target.value)}
                    placeholder="0"
                    className="h-6 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Max items</Label>
                  <Input
                    type="number"
                    min={0}
                    value={prop.maxItems}
                    onChange={(e) => set("maxItems", e.target.value)}
                    placeholder="∞"
                    className="h-6 text-xs"
                  />
                </div>
              </div>

              {/* Object item schema editor */}
              {prop.itemType === "object" && prop.itemSchema && (
                <div className="space-y-2 pt-2 border-t border-border">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Item Object Schema</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        set("itemSchema", {
                          ...prop.itemSchema!,
                          properties: [...prop.itemSchema!.properties, defaultProp()],
                        })
                      }
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add field
                    </Button>
                  </div>
                  {prop.itemSchema.properties.length > 0 && (
                    <div className="space-y-1.5 pl-2 border-l border-border">
                      {prop.itemSchema.properties.map((child, i) => (
                        <PropertyRow
                          key={child.id}
                          prop={child}
                          depth={depth + 1}
                          failingCount={0}
                          totalDataItems={0}
                          onChange={(updated) => {
                            const next = [...prop.itemSchema!.properties];
                            next[i] = updated;
                            set("itemSchema", { ...prop.itemSchema!, properties: next });
                          }}
                          onRemove={() => {
                            const next = prop.itemSchema!.properties.filter((_, j) => j !== i);
                            set("itemSchema", { ...prop.itemSchema!, properties: next });
                          }}
                        />
                      ))}
                    </div>
                  )}
                  {prop.itemSchema.properties.length === 0 && (
                    <div className="text-xs text-muted-foreground italic">
                      No fields defined yet. Click "Add field" to define the object structure.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Object: nested properties */}
          {prop.type === "object" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Nested properties</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => set("properties", [...prop.properties, defaultProp()])}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
              {prop.properties.length > 0 && (
                <div className="space-y-1.5 pl-2 border-l border-border">
                  {prop.properties.map((child, i) => (
                    <PropertyRow
                      key={child.id}
                      prop={child}
                      depth={depth + 1}
                      failingCount={0}
                      totalDataItems={0}
                      onChange={(updated) => {
                        const next = [...prop.properties];
                        next[i] = updated;
                        set("properties", next);
                      }}
                      onRemove={() => {
                        const next = prop.properties.filter((_, j) => j !== i);
                        set("properties", next);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── VisualBuilder ────────────────────────────────────────────────────────────

interface VisualBuilderProps {
  schemaJson: string;
  onChange: (json: string) => void;
  /** path → count of data items failing at that path */
  validationFailingPaths: Map<string, number>;
  totalDataItems: number;
}

export function VisualBuilder({
  schemaJson,
  onChange,
  validationFailingPaths,
  totalDataItems,
}: VisualBuilderProps) {
  const [formData, setFormData] = useState<SchemaFormData | null>(null);
  const [parseError, setParseError] = useState(false);
  // Track when we ourselves triggered the schemaJson change so we don't
  // re-parse and rebuild PropertyDef objects (which would remount inputs and
  // lose keyboard focus on every keystroke).
  const selfChangedRef = useRef(false);

  // Parse incoming schemaJson into formData — but skip when we were the source
  useEffect(() => {
    if (selfChangedRef.current) {
      selfChangedRef.current = false;
      return;
    }
    if (!schemaJson.trim()) {
      setFormData({ title: "", description: "", properties: [] });
      setParseError(false);
      return;
    }
    const parsed = jsonToSchemaFormData(schemaJson);
    if (parsed) {
      setFormData(parsed);
      setParseError(false);
    } else {
      setParseError(true);
    }
  }, [schemaJson]);

  const handleFormChange = useCallback(
    (updated: SchemaFormData) => {
      selfChangedRef.current = true;
      setFormData(updated);
      onChange(schemaFormDataToJson(updated));
    },
    [onChange],
  );

  if (parseError) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          The JSON has a syntax error. Switch to <strong>Code</strong> view to fix it before editing
          visually.
        </span>
      </div>
    );
  }

  if (!formData) return null;

  const set = <K extends keyof SchemaFormData>(key: K, value: SchemaFormData[K]) => {
    handleFormChange({ ...formData, [key]: value });
  };

  return (
    <div className="space-y-4">
      {/* Title & description */}
      <div className="grid grid-cols-1 gap-3">
        <div className="space-y-1">
          <Label htmlFor="vb-title" className="text-xs">
            Title <span className="text-destructive">*</span>
          </Label>
          <Input
            id="vb-title"
            value={formData.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="My Schema"
            className="h-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="vb-description" className="text-xs">
            Description <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="vb-description"
            value={formData.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="Describe what this schema represents…"
            rows={2}
            className="text-sm resize-none"
          />
        </div>
      </div>

      {/* Properties */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">
            Properties{" "}
            <span className="text-muted-foreground font-normal">
              ({formData.properties.length})
            </span>
          </Label>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => set("properties", [...formData.properties, defaultProp()])}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add property
          </Button>
        </div>

        {formData.properties.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            No properties yet. Click "Add property" to start building your schema.
          </div>
        )}

        <div className="space-y-1.5">
          {formData.properties.map((prop, i) => {
            const failingCount = validationFailingPaths.get(`/${prop.name}`) ?? 0;
            return (
              <PropertyRow
                key={prop.id}
                prop={prop}
                failingCount={failingCount}
                totalDataItems={totalDataItems}
                onChange={(updated) => {
                  const next = [...formData.properties];
                  next[i] = updated;
                  set("properties", next);
                }}
                onRemove={() => {
                  const next = formData.properties.filter((_, j) => j !== i);
                  set("properties", next);
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
