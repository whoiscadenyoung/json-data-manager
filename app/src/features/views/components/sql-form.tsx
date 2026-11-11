import type { Step } from "@caden/data-core/views";
import { CodeEditor } from "@caden/ui/components/code-editor";
import { Label } from "@caden/ui/components/label";

import { checkSql, sqlCompletions, sqlTableNames } from "../lib/expression-assist";

function excerpt(query: string, from: number, to: number): string {
  const text = query.slice(from, Math.max(to, from + 1)).trim();
  return text === "" ? "" : ` (at "${text.length > 30 ? `${text.slice(0, 30)}…` : text}")`;
}

/**
 * SQL: one read-only SELECT over the previous step. The compiler's analysis
 * checks it as you type (parse errors, unknown tables, forbidden functions,
 * output column names), with the error underlined at its position.
 */
export function SqlForm({
  aliases,
  onChange,
  step,
}: {
  /** The view's declared input aliases (each is readable as in_<alias>). */
  aliases: string[];
  onChange: (step: Step) => void;
  step: Extract<Step, { kind: "sql" }>;
}) {
  const check = checkSql(step.query, aliases);
  const names = sqlTableNames(aliases);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label>SQL query</Label>
        <CodeEditor
          ariaLabel="SQL query"
          completions={sqlCompletions(aliases)}
          diagnostics={check.problems}
          height="140px"
          onChange={(query) => {
            onChange({ ...step, query });
          }}
          placeholder="select * from prev"
          value={step.query}
        />
        {check.problems.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm text-destructive" role="alert">
            {check.problems.map((problem) => (
              <li key={`${problem.from}-${problem.to}-${problem.message}`}>
                {problem.message}
                {excerpt(step.query, problem.from, problem.to)}
              </li>
            ))}
          </ul>
        ) : (
          check.columns !== undefined && (
            <p className="text-sm">
              Returns <span className="font-medium">{check.columns.join(", ")}</span>
            </p>
          )
        )}
      </div>
      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <p>
          Write one SELECT. Available tables:{" "}
          {names.map((name, index) => (
            <span key={name}>
              {index > 0 && ", "}
              <code className="rounded bg-muted px-1 py-0.5">{name}</code>
            </span>
          ))}
          . <code className="rounded bg-muted px-1 py-0.5">prev</code> is the previous step&apos;s
          rows; <code className="rounded bg-muted px-1 py-0.5">in_&lt;alias&gt;</code> is a whole
          input.
        </p>
        <p>
          Output rule: columns named <code className="rounded bg-muted px-1 py-0.5">d</code>,{" "}
          <code className="rounded bg-muted px-1 py-0.5">row_id</code> and{" "}
          <code className="rounded bg-muted px-1 py-0.5">geom</code> keep a row&apos;s fields, id
          and geometry; any other column becomes a field of that name. Name every column (
          <code className="rounded bg-muted px-1 py-0.5">as total</code>). Only SELECT is allowed,
          and functions that read files, settings or other queries are blocked.
        </p>
      </div>
    </div>
  );
}
