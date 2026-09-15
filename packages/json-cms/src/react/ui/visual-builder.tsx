import { AlertCircle, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

import { REFERENCE_KEYWORD, isReferenceMeta } from "../../shared/reference.js";
import { cn } from "./lib/utils.js";
import { Button } from "./primitives/button.js";
import { Input } from "./primitives/input.js";
import { Label } from "./primitives/label.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PropertyType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "reference";

/** A dataset the visual builder can offer as a reference field's target. */
export interface ReferenceDatasetOption {
  id: string;
  title: string;
  /** The target dataset's JSON schema — introspected for its property names (the display-property picker). */
  schema: unknown;
}

export interface PropertyDef {
  id: string;
  name: string;
  type: PropertyType;
  /** When true the field also accepts null (JSON Schema `type: [T, "null"]`). */
  nullable: boolean;
  title: string;
  description: string;
  required: boolean;
  // String
  format: string;
  minLength: string;
  maxLength: string;
  pattern: string;
  enum: string;
  // Number/integer
  minimum: string;
  maximum: string;
  multipleOf: string;
  // Array
  itemType: string;
  minItems: string;
  maxItems: string;
  itemSchema: PropertyDef | null; // For array of objects
  // Object
  properties: PropertyDef[];
  // Reference (foreign key into another dataset — see ../../shared/reference.ts)
  referenceDatasetId: string;
  referenceDisplayProperty: string;
  referenceMultiple: boolean;
}

export interface SchemaFormData {
  title: string;
  description: string;
  properties: PropertyDef[];
}

// ─── Serialization ───────────────────────────────────────────────────────────

function splitEnum(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function stringConstraints(prop: PropertyDef, schema: Record<string, unknown>): void {
  if (prop.format) {
    schema.format = prop.format;
  }
  if (prop.minLength !== "") {
    schema.minLength = Number(prop.minLength);
  }
  if (prop.maxLength !== "") {
    schema.maxLength = Number(prop.maxLength);
  }
  if (prop.pattern) {
    schema.pattern = prop.pattern;
  }
  if (prop.enum.trim()) {
    schema.enum = splitEnum(prop.enum);
  }
}

function numberConstraints(prop: PropertyDef, schema: Record<string, unknown>): void {
  if (prop.minimum !== "") {
    schema.minimum = Number(prop.minimum);
  }
  if (prop.maximum !== "") {
    schema.maximum = Number(prop.maximum);
  }
  if (prop.multipleOf !== "") {
    schema.multipleOf = Number(prop.multipleOf);
  }
  if (prop.enum.trim()) {
    schema.enum = splitEnum(prop.enum).map(Number);
  }
}

function arrayConstraints(prop: PropertyDef, schema: Record<string, unknown>): void {
  if (prop.itemType) {
    if (prop.itemType === "object" && prop.itemSchema) {
      // Array of objects with defined schema
      const itemSchema = makePropertySchema(prop.itemSchema);
      delete itemSchema.name;
      delete itemSchema.required;
      schema.items = itemSchema;
    } else {
      // Array of primitives
      schema.items = { type: prop.itemType };
    }
  }
  if (prop.minItems !== "") {
    schema.minItems = Number(prop.minItems);
  }
  if (prop.maxItems !== "") {
    schema.maxItems = Number(prop.maxItems);
  }
}

function objectConstraints(prop: PropertyDef, schema: Record<string, unknown>): void {
  const nestedProps: Record<string, unknown> = {},
    nestedRequired: string[] = [];
  for (const child of prop.properties) {
    nestedProps[child.name] = makePropertySchema(child);
    if (child.required) {
      nestedRequired.push(child.name);
    }
  }
  schema.properties = nestedProps;
  if (nestedRequired.length > 0) {
    schema.required = nestedRequired;
  }
}

/**
 * A reference field is a plain `string` (single) or `array` of `string`
 * (many) property annotated with `x-reference` — see ../../shared/reference.ts.
 * `schema.type` is set here rather than by the generic assignment in
 * `makePropertySchema`, since it depends on `referenceMultiple` rather than
 * on `prop.type` directly.
 */
function referenceConstraints(prop: PropertyDef, schema: Record<string, unknown>): void {
  if (prop.referenceMultiple) {
    schema.type = prop.nullable ? ["array", "null"] : "array";
    schema.items = { type: "string" };
  } else {
    schema.type = prop.nullable ? ["string", "null"] : "string";
  }
  schema[REFERENCE_KEYWORD] = {
    cardinality: prop.referenceMultiple ? "many" : "one",
    datasetId: prop.referenceDatasetId,
    ...(prop.referenceDisplayProperty ? { displayProperty: prop.referenceDisplayProperty } : {}),
  };
}

function applyTypeConstraints(prop: PropertyDef, schema: Record<string, unknown>): void {
  if (prop.type === "string") {
    stringConstraints(prop, schema);
  } else if (prop.type === "number" || prop.type === "integer") {
    numberConstraints(prop, schema);
  } else if (prop.type === "array") {
    arrayConstraints(prop, schema);
  } else if (prop.type === "object" && prop.properties.length > 0) {
    objectConstraints(prop, schema);
  }
}

function makePropertySchema(prop: PropertyDef): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  if (prop.title) {
    schema.title = prop.title;
  }
  if (prop.description) {
    schema.description = prop.description;
  }

  if (prop.type === "reference") {
    referenceConstraints(prop, schema);
    return schema;
  }

  schema.type = prop.nullable ? [prop.type, "null"] : prop.type;
  applyTypeConstraints(prop, schema);
  return schema;
}

export function schemaFormDataToJson(data: SchemaFormData): string {
  const properties: Record<string, unknown> = {},
    required: string[] = [];

  for (const prop of data.properties) {
    if (!prop.name.trim()) {
      continue;
    }
    properties[prop.name] = makePropertySchema(prop);
    if (prop.required) {
      required.push(prop.name);
    }
  }

  const schema: Record<string, unknown> = {
    description: data.description,
    properties,
    title: data.title,
    type: "object",
  };
  if (required.length > 0) {
    schema.required = required;
  }

  return JSON.stringify(schema, null, 2);
}

// ─── Deserialization ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPropertyType(value: unknown): value is PropertyType {
  return typeof value === "string" && PROPERTY_TYPES.some((t) => t === value);
}

/** A string field, or "" when the value isn't a string. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Serialize a numeric constraint to its text-input form ("" when absent). */
function numToInput(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value);
}

/** Split a possibly-nullable JSON-Schema `type` into a base type + nullable flag. */
function parseTypeInfo(rawType: unknown): { type: PropertyType; nullable: boolean } {
  if (Array.isArray(rawType)) {
    const base = rawType.find((t) => t !== "null");
    return { nullable: rawType.includes("null"), type: isPropertyType(base) ? base : "string" };
  }
  return { nullable: false, type: isPropertyType(rawType) ? rawType : "string" };
}

/** Derive the array item type (a plain string) from a schema's `items`. */
function parseItemType(items: unknown): string {
  if (!isRecord(items)) {
    return "";
  }
  const raw = items.type;
  if (Array.isArray(raw)) {
    const base = raw.find((t) => t !== "null");
    return typeof base === "string" ? base : "";
  }
  return typeof raw === "string" ? raw : "";
}

let propIdCounter = 0;
function nextId() {
  propIdCounter += 1;
  return `prop_${propIdCounter}`;
}

function parseChildProperties(
  properties: Record<string, unknown>,
  required: unknown,
): PropertyDef[] {
  const requiredSet = new Set<string>(
    Array.isArray(required) ? required.filter((r): r is string => typeof r === "string") : [],
  );
  return Object.entries(properties).map(([k, v]) => parsePropertyDef(k, v, requiredSet));
}

/** If `schema` carries `x-reference`, overrides `prop` to a reference field in place and returns `true`. */
function applyReferenceOverride(prop: PropertyDef, schema: Record<string, unknown>): boolean {
  const meta = schema[REFERENCE_KEYWORD];
  if (!isReferenceMeta(meta)) {
    return false;
  }
  prop.type = "reference";
  prop.referenceDatasetId = meta.datasetId;
  prop.referenceDisplayProperty = meta.displayProperty ?? "";
  prop.referenceMultiple = meta.cardinality === "many";
  return true;
}

/** Parses an object's nested properties, or an array-of-objects' item schema, into `prop` in place. */
function applyNestedSchema(
  prop: PropertyDef,
  type: PropertyType,
  schema: Record<string, unknown>,
): void {
  if (type === "object" && isRecord(schema.properties)) {
    prop.properties = parseChildProperties(schema.properties, schema.required);
    return;
  }
  if (
    type === "array" &&
    prop.itemType === "object" &&
    isRecord(schema.items) &&
    schema.items.type === "object"
  ) {
    prop.itemSchema = parsePropertyDef("item", schema.items, new Set());
  }
}

function parsePropertyDef(name: string, rawSchema: unknown, requiredSet: Set<string>): PropertyDef {
  const schema = isRecord(rawSchema) ? rawSchema : {},
    // `type` may be a nullable union like ["string", "null"]; split it into a
    // base type plus a `nullable` flag so the type <select> stays scalar.
    { type, nullable } = parseTypeInfo(schema.type),
    prop: PropertyDef = {
      description: asString(schema.description),
      enum: Array.isArray(schema.enum) ? schema.enum.map(String).join(", ") : "",
      format: asString(schema.format),
      id: nextId(),
      itemSchema: null,
      itemType: parseItemType(schema.items),
      maxItems: numToInput(schema.maxItems),
      maxLength: numToInput(schema.maxLength),
      maximum: numToInput(schema.maximum),
      minItems: numToInput(schema.minItems),
      minLength: numToInput(schema.minLength),
      minimum: numToInput(schema.minimum),
      multipleOf: numToInput(schema.multipleOf),
      name,
      nullable,
      pattern: asString(schema.pattern),
      properties: [],
      referenceDatasetId: "",
      referenceDisplayProperty: "",
      referenceMultiple: false,
      required: requiredSet.has(name),
      title: asString(schema.title),
      type,
    };

  if (applyReferenceOverride(prop, schema)) {
    return prop;
  }

  applyNestedSchema(prop, type, schema);
  return prop;
}

export function jsonToSchemaFormData(json: string): SchemaFormData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    description: asString(parsed.description),
    properties: isRecord(parsed.properties)
      ? parseChildProperties(parsed.properties, parsed.required)
      : [],
    title: asString(parsed.title),
  };
}

// ─── Default property ─────────────────────────────────────────────────────────

function defaultProp(): PropertyDef {
  return {
    description: "",
    enum: "",
    format: "",
    id: nextId(),
    itemSchema: null,
    itemType: "",
    maxItems: "",
    maxLength: "",
    maximum: "",
    minItems: "",
    minLength: "",
    minimum: "",
    multipleOf: "",
    name: "",
    nullable: false,
    pattern: "",
    properties: [],
    referenceDatasetId: "",
    referenceDisplayProperty: "",
    referenceMultiple: false,
    required: false,
    title: "",
    type: "string",
  };
}

// ─── PropertyRow ──────────────────────────────────────────────────────────────

const STRING_FORMATS = ["", "email", "uri", "date", "date-time", "time", "password", "hostname"],
  PROPERTY_TYPES: PropertyType[] = [
    "string",
    "number",
    "integer",
    "boolean",
    "object",
    "array",
    "reference",
  ],
  // A reference field's target/display-property picker needs the source
  // property to sit directly in `data` (top-level), so array items and
  // nested-object fields can't be reference fields themselves.
  ARRAY_ITEM_TYPES = PROPERTY_TYPES.filter((t) => t !== "array" && t !== "reference"),
  NESTED_PROPERTY_TYPES = PROPERTY_TYPES.filter((t) => t !== "reference"),
  // Stable empty-array reference for the `availableDatasets` prop's default —
  // a fresh `[]` literal on every render would break memoization/referential
  // equality for consumers that don't pass their own.
  EMPTY_REFERENCE_DATASETS: ReferenceDatasetOption[] = [];

function ItemObjectSchemaEditor({
  itemSchema,
  depth,
  onChange,
}: {
  itemSchema: PropertyDef;
  depth: number;
  onChange: (next: PropertyDef) => void;
}) {
  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium">Item Object Schema</Label>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            onChange({ ...itemSchema, properties: [...itemSchema.properties, defaultProp()] });
          }}
        >
          <Plus className="h-3 w-3 mr-1" />
          Add field
        </Button>
      </div>
      {itemSchema.properties.length > 0 && (
        <div className="space-y-1.5 pl-2 border-l border-border">
          {itemSchema.properties.map((child, i) => (
            <PropertyRow
              key={child.id}
              prop={child}
              depth={depth + 1}
              failingCount={0}
              totalDataItems={0}
              onChange={(updated) => {
                const next = [...itemSchema.properties];
                next[i] = updated;
                onChange({ ...itemSchema, properties: next });
              }}
              onRemove={() => {
                onChange({
                  ...itemSchema,
                  properties: itemSchema.properties.filter((_, j) => j !== i),
                });
              }}
            />
          ))}
        </div>
      )}
      {itemSchema.properties.length === 0 && (
        <div className="text-xs text-muted-foreground italic">
          No fields defined yet. Click "Add field" to define the object structure.
        </div>
      )}
    </div>
  );
}

type PropSetter = <K extends keyof PropertyDef>(key: K, value: PropertyDef[K]) => void;

function PropertyRowHeader({
  prop,
  set,
  expanded,
  onToggle,
  onRemove,
  failingCount,
  totalDataItems,
  typeOptions,
}: {
  prop: PropertyDef;
  set: PropSetter;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  failingCount: number;
  totalDataItems: number;
  typeOptions: PropertyType[];
}) {
  const hasFailures = failingCount > 0;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
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
        onChange={(e) => {
          set("name", e.target.value);
        }}
        placeholder="property_name"
        className="h-6 text-xs font-mono flex-1 min-w-0"
      />

      {/* Type selector */}
      <select
        value={prop.type}
        onChange={(e) => {
          if (isPropertyType(e.target.value)) {
            set("type", e.target.value);
          }
        }}
        className={cn(
          "h-6 rounded-md border border-input bg-background px-1.5 text-xs",
          "focus:outline-none focus:ring-1 focus:ring-ring",
          "shrink-0",
        )}
      >
        {typeOptions.map((t) => (
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
          onChange={(e) => {
            set("required", e.target.checked);
          }}
          className="h-3 w-3 rounded"
        />
        req
      </label>

      {/* Nullable toggle */}
      <label className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 cursor-pointer">
        <input
          type="checkbox"
          checked={prop.nullable}
          onChange={(e) => {
            set("nullable", e.target.checked);
          }}
          className="h-3 w-3 rounded"
        />
        null
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
  );
}

function StringConstraints({ prop, set }: { prop: PropertyDef; set: PropSetter }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Format</Label>
          <select
            value={prop.format}
            onChange={(e) => {
              set("format", e.target.value);
            }}
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
            onChange={(e) => {
              set("pattern", e.target.value);
            }}
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
            onChange={(e) => {
              set("minLength", e.target.value);
            }}
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
            onChange={(e) => {
              set("maxLength", e.target.value);
            }}
            placeholder="∞"
            className="h-6 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Enum values (comma-separated)</Label>
        <Input
          value={prop.enum}
          onChange={(e) => {
            set("enum", e.target.value);
          }}
          placeholder="option1, option2, option3"
          className="h-6 text-xs"
        />
      </div>
    </div>
  );
}

function NumberConstraints({ prop, set }: { prop: PropertyDef; set: PropSetter }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Minimum</Label>
          <Input
            type="number"
            value={prop.minimum}
            onChange={(e) => {
              set("minimum", e.target.value);
            }}
            placeholder="−∞"
            className="h-6 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Maximum</Label>
          <Input
            type="number"
            value={prop.maximum}
            onChange={(e) => {
              set("maximum", e.target.value);
            }}
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
            onChange={(e) => {
              set("multipleOf", e.target.value);
            }}
            placeholder="—"
            className="h-6 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Enum values (comma-separated numbers)</Label>
        <Input
          value={prop.enum}
          onChange={(e) => {
            set("enum", e.target.value);
          }}
          placeholder="1, 2, 3"
          className="h-6 text-xs"
        />
      </div>
    </div>
  );
}

function ArrayConstraints({
  prop,
  set,
  depth,
}: {
  prop: PropertyDef;
  set: PropSetter;
  depth: number;
}) {
  return (
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
            {ARRAY_ITEM_TYPES.map((t) => (
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
            onChange={(e) => {
              set("minItems", e.target.value);
            }}
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
            onChange={(e) => {
              set("maxItems", e.target.value);
            }}
            placeholder="∞"
            className="h-6 text-xs"
          />
        </div>
      </div>

      {prop.itemType === "object" && prop.itemSchema && (
        <ItemObjectSchemaEditor
          itemSchema={prop.itemSchema}
          depth={depth}
          onChange={(next) => {
            set("itemSchema", next);
          }}
        />
      )}
    </div>
  );
}

/** Top-level property names of a candidate target dataset's schema — the display-property picker's options. */
function targetDatasetProperties(dataset: ReferenceDatasetOption | undefined): string[] {
  if (!dataset || !isRecord(dataset.schema)) {
    return [];
  }
  const props = dataset.schema.properties;
  return isRecord(props) ? Object.keys(props) : [];
}

function ReferenceConstraints({
  prop,
  set,
  availableDatasets,
}: {
  prop: PropertyDef;
  set: PropSetter;
  availableDatasets: ReferenceDatasetOption[];
}) {
  const selectedDataset = availableDatasets.find((d) => d.id === prop.referenceDatasetId),
    displayPropertyOptions = targetDatasetProperties(selectedDataset);

  if (availableDatasets.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        No other datasets exist yet to link to. Create one first, then come back to reference it.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Target dataset</Label>
          <select
            value={prop.referenceDatasetId}
            onChange={(e) => {
              // Not also resetting `referenceDisplayProperty` here is deliberate:
              // `set` replaces the whole prop from its own single render-time
              // snapshot, so a second `set` call in this handler would
              // silently undo the first (see PropertyRow's `set`). A
              // display-property value that no longer matches the new
              // dataset's fields just falls back to showing the raw entry id
              // — self-healing, not a correctness issue — until the user
              // picks a new one.
              set("referenceDatasetId", e.target.value);
            }}
            className="w-full h-6 rounded-md border border-input bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="" disabled>
              Select a dataset
            </option>
            {availableDatasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Display property</Label>
          <select
            value={prop.referenceDisplayProperty}
            disabled={!selectedDataset}
            onChange={(e) => {
              set("referenceDisplayProperty", e.target.value);
            }}
            className={cn(
              "w-full h-6 rounded-md border border-input bg-background px-1.5 text-xs",
              "focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50",
            )}
          >
            <option value="">(entry ID)</option>
            {displayPropertyOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={prop.referenceMultiple}
          onChange={(e) => {
            set("referenceMultiple", e.target.checked);
          }}
          className="h-3 w-3 rounded"
        />
        Allow linking to multiple entries
      </label>
      {!prop.referenceDatasetId && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          Choose a target dataset — required for this field to work.
        </p>
      )}
    </div>
  );
}

/** Add/edit/remove an object property's own nested fields — recurses into `PropertyRow`. */
function NestedProperties({
  prop,
  set,
  depth,
}: {
  prop: PropertyDef;
  set: PropSetter;
  depth: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Nested properties</Label>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            set("properties", [...prop.properties, defaultProp()]);
          }}
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
  );
}

/** Dispatches to the constraints editor for `prop`'s type — one branch per {@link PropertyType}. */
function PropertyTypeConstraints({
  prop,
  set,
  depth,
  availableDatasets,
}: {
  prop: PropertyDef;
  set: PropSetter;
  depth: number;
  availableDatasets: ReferenceDatasetOption[];
}) {
  if (prop.type === "string") {
    return <StringConstraints prop={prop} set={set} />;
  }
  if (prop.type === "number" || prop.type === "integer") {
    return <NumberConstraints prop={prop} set={set} />;
  }
  if (prop.type === "array") {
    return <ArrayConstraints prop={prop} set={set} depth={depth} />;
  }
  if (prop.type === "reference") {
    return <ReferenceConstraints prop={prop} set={set} availableDatasets={availableDatasets} />;
  }
  if (prop.type === "object") {
    return <NestedProperties prop={prop} set={set} depth={depth} />;
  }
  return null;
}

function PropertyRow({
  prop,
  onChange,
  onRemove,
  failingCount,
  totalDataItems,
  depth = 0,
  availableDatasets = EMPTY_REFERENCE_DATASETS,
}: {
  prop: PropertyDef;
  onChange: (updated: PropertyDef) => void;
  onRemove: () => void;
  failingCount: number;
  totalDataItems: number;
  depth?: number;
  availableDatasets?: ReferenceDatasetOption[];
}) {
  const [expanded, setExpanded] = useState(false),
    set = <K extends keyof PropertyDef>(key: K, value: PropertyDef[K]) => {
      onChange({ ...prop, [key]: value });
    };

  return (
    <div className={cn("rounded-md border border-border bg-card", depth > 0 && "bg-muted/30")}>
      <PropertyRowHeader
        prop={prop}
        set={set}
        expanded={expanded}
        onToggle={() => {
          setExpanded(!expanded);
        }}
        onRemove={onRemove}
        failingCount={failingCount}
        totalDataItems={totalDataItems}
        typeOptions={depth === 0 ? PROPERTY_TYPES : NESTED_PROPERTY_TYPES}
      />

      {/* Expanded: advanced options */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Title</Label>
              <Input
                value={prop.title}
                onChange={(e) => {
                  set("title", e.target.value);
                }}
                placeholder="Display name"
                className="h-6 text-xs"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Description</Label>
              <Input
                value={prop.description}
                onChange={(e) => {
                  set("description", e.target.value);
                }}
                placeholder="Field description"
                className="h-6 text-xs"
              />
            </div>
          </div>

          <PropertyTypeConstraints
            prop={prop}
            set={set}
            depth={depth}
            availableDatasets={availableDatasets}
          />
        </div>
      )}
    </div>
  );
}

// ─── VisualBuilder ────────────────────────────────────────────────────────────

interface VisualBuilderProps {
  schemaJson: string;
  onChange: (json: string) => void;
  /** Path → count of data items failing at that path */
  validationFailingPaths: Map<string, number>;
  totalDataItems: number;
  /** Other datasets a "reference" property can link to. Omit/empty to hide that capability entirely. */
  availableDatasets?: ReferenceDatasetOption[];
}

export function VisualBuilder({
  schemaJson,
  onChange,
  validationFailingPaths,
  totalDataItems,
  availableDatasets = EMPTY_REFERENCE_DATASETS,
}: VisualBuilderProps) {
  const [formData, setFormData] = useState<SchemaFormData | null>(null),
    [parseError, setParseError] = useState(false),
    // The last `schemaJson` value reflected in `formData`. `handleFormChange`
    // records the JSON it emits here, so a change that originated in this
    // component is recognized and skipped below — inputs keep focus instead of
    // being rebuilt. Any other (external) change re-parses.
    [syncedJson, setSyncedJson] = useState<string | undefined>(undefined);

  // Sync the externally-controlled `schemaJson` into form state during render
  // (not an effect, so a self-originated change never rebuilds the inputs).
  if (schemaJson !== syncedJson) {
    setSyncedJson(schemaJson);
    if (schemaJson.trim()) {
      const parsed = jsonToSchemaFormData(schemaJson);
      if (parsed) {
        setFormData(parsed);
        setParseError(false);
      } else {
        setParseError(true);
      }
    } else {
      setFormData({ description: "", properties: [], title: "" });
      setParseError(false);
    }
  }

  const handleFormChange = useCallback(
    (updated: SchemaFormData) => {
      const json = schemaFormDataToJson(updated);
      setFormData(updated);
      setSyncedJson(json);
      onChange(json);
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

  if (!formData) {
    return null;
  }

  const set = <K extends keyof SchemaFormData>(key: K, value: SchemaFormData[K]) => {
    handleFormChange({ ...formData, [key]: value });
  };

  return (
    <div className="space-y-4">
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
            onClick={() => {
              set("properties", [...formData.properties, defaultProp()]);
            }}
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
                availableDatasets={availableDatasets}
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
