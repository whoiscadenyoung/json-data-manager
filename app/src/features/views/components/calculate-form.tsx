import { EXPRESSION_FUNCTIONS } from "@caden/data-core/views";
import type { FieldType, ViewNode } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { CodeEditor } from "@caden/ui/components/code-editor";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Plus, Trash2 } from "lucide-react";

import { checkExpression, expressionCompletions, TYPE_LABELS } from "../lib/expression-assist";

/** Where an error sits in the text, in the words the editor underlines. */
function excerpt(src: string, from: number, to: number): string {
  const text = src.slice(from, Math.max(to, from + 1)).trim();
  return text === "" ? "" : ` (at "${text.length > 24 ? `${text.slice(0, 24)}…` : text}")`;
}

function CalculateField({
  entry,
  fieldTypes,
  fields,
  index,
  onChange,
  onRemove,
}: {
  entry: { field: string; expr: string };
  fieldTypes: ReadonlyMap<string, FieldType> | undefined;
  fields: string[] | undefined;
  index: number;
  onChange: (patch: Partial<{ field: string; expr: string }>) => void;
  onRemove: (() => void) | undefined;
}) {
  const check = checkExpression(entry.expr, fields, fieldTypes);
  return (
    <fieldset
      className="flex flex-col gap-3 rounded-md border p-3"
      aria-label={`Field ${index + 1}`}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`calculate-field-${index}`}>New field name</Label>
        <div className="flex items-center gap-2">
          <Input
            aria-label={index === 0 ? "New field name" : `New field name ${index + 1}`}
            className="w-64"
            id={`calculate-field-${index}`}
            onChange={(event) => {
              onChange({ field: event.target.value });
            }}
            placeholder="e.g. costPerSite"
            value={entry.field}
          />
          {onRemove !== undefined && (
            <Button
              aria-label={`Remove field ${index + 1}`}
              onClick={onRemove}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          )}
        </div>
        {fields !== undefined && entry.field !== "" && fields.includes(entry.field) && (
          <p className="text-xs text-muted-foreground">
            A field with this name already exists. The calculation replaces its value.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label>Expression</Label>
        <CodeEditor
          ariaLabel={index === 0 ? "Expression" : `Expression ${index + 1}`}
          completions={expressionCompletions(fields)}
          diagnostics={check.problems}
          height="84px"
          onChange={(expr) => {
            onChange({ expr });
          }}
          placeholder={"e.g. cost / sites, or replace(Round, 'Round ', '')"}
          value={entry.expr}
        />
        {check.problems.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-destructive" role="alert">
            {check.problems.map((problem) => (
              <li key={`${problem.from}-${problem.to}-${problem.message}`}>
                {problem.message}
                {excerpt(entry.expr, problem.from, problem.to)}
              </li>
            ))}
          </ul>
        ) : check.type !== undefined ? (
          <p className="text-sm">
            Result type: <span className="font-medium">{TYPE_LABELS[check.type]}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Type a field name (quote names with spaces or dots: &quot;my field&quot;), numbers,
            &apos;text&apos;, + - * / and comparisons.
          </p>
        )}
      </div>
    </fieldset>
  );
}

/**
 * Calculate: new fields and the expressions that fill them. A node holds
 * several; they evaluate in order, so a later one may read an earlier one.
 * Each expression is stored as text; the editor checks it live with the
 * compiler's own analysis, underlines the problem and offers the row's fields
 * and the allowed functions.
 */
export function CalculateForm({
  fieldTypes,
  fields,
  onChange,
  node,
}: {
  /** The fields of the rows reaching this node (undefined = shape unknown, any name accepted). */
  fields: string[] | undefined;
  /** Declared types for those fields, from the inputs' json_schema (#335) — present, the form can name the result type instead of "depends on the data". */
  fieldTypes?: ReadonlyMap<string, FieldType> | undefined;
  onChange: (node: ViewNode) => void;
  node: Extract<ViewNode, { kind: "calculate" }>;
}) {
  const setField = (index: number, patch: Partial<{ field: string; expr: string }>): void => {
    onChange({
      ...node,
      fields: node.fields.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    });
  };
  return (
    <div className="flex flex-col gap-4">
      {node.fields.map((entry, index) => (
        <CalculateField
          // oxlint-disable-next-line react/no-array-index-key -- fields are an ordered, unkeyed list.
          key={index}
          entry={entry}
          fieldTypes={fieldTypes}
          fields={
            fields === undefined
              ? undefined
              : [...fields, ...node.fields.slice(0, index).map((earlier) => earlier.field)]
          }
          index={index}
          onChange={(patch) => {
            setField(index, patch);
          }}
          onRemove={
            node.fields.length > 1
              ? () => {
                  onChange({ ...node, fields: node.fields.filter((_, i) => i !== index) });
                }
              : undefined
          }
        />
      ))}
      <Button
        className="w-fit"
        onClick={() => {
          onChange({ ...node, fields: [...node.fields, { field: "", expr: "" }] });
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="h-3.5 w-3.5" />
        Add field
      </Button>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Functions you can use</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {EXPRESSION_FUNCTIONS.map((fn) => (
            <li key={fn.name}>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{fn.signature}</code>
              <span className="ml-2 text-xs text-muted-foreground">{fn.description}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
