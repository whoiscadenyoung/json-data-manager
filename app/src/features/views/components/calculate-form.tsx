import { EXPRESSION_FUNCTIONS } from "@caden/data-core/views";
import type { Step } from "@caden/data-core/views";
import { CodeEditor } from "@caden/ui/components/code-editor";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";

import { checkExpression, expressionCompletions, TYPE_LABELS } from "../lib/expression-assist";

/** Where an error sits in the text, in the words the editor underlines. */
function excerpt(src: string, from: number, to: number): string {
  const text = src.slice(from, Math.max(to, from + 1)).trim();
  return text === "" ? "" : ` (at "${text.length > 24 ? `${text.slice(0, 24)}…` : text}")`;
}

/**
 * Calculate: a new field and the expression that fills it. The expression is
 * stored as text; the editor checks it live with the compiler's own analysis,
 * underlines the problem and offers the row's fields and the allowed functions.
 */
export function CalculateForm({
  fields,
  onChange,
  step,
}: {
  /** The fields of the rows reaching this step (undefined = shape unknown, any name accepted). */
  fields: string[] | undefined;
  onChange: (step: Step) => void;
  step: Extract<Step, { kind: "calculate" }>;
}) {
  const check = checkExpression(step.expr, fields);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="calculate-field">New field name</Label>
        <Input
          className="w-64"
          id="calculate-field"
          onChange={(event) => {
            onChange({ ...step, field: event.target.value });
          }}
          placeholder="e.g. costPerSite"
          value={step.field}
        />
        {fields !== undefined && fields.includes(step.field) && (
          <p className="text-xs text-muted-foreground">
            A field with this name already exists. The calculation replaces its value.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label>Expression</Label>
        <CodeEditor
          ariaLabel="Expression"
          completions={expressionCompletions(fields)}
          diagnostics={check.problems}
          height="84px"
          onChange={(expr) => {
            onChange({ ...step, expr });
          }}
          placeholder={'e.g. cost / sites, or concat(name, " (", state, ")")'}
          value={step.expr}
        />
        {check.problems.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-destructive" role="alert">
            {check.problems.map((problem) => (
              <li key={`${problem.from}-${problem.to}-${problem.message}`}>
                {problem.message}
                {excerpt(step.expr, problem.from, problem.to)}
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
