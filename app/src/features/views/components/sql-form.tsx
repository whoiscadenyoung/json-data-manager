import type { ViewNode } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { CodeEditor } from "@caden/ui/components/code-editor";
import { Label } from "@caden/ui/components/label";

import { checkSql, sqlCompletions, sqlTableNames } from "../lib/expression-assist";
import { nodeOptions } from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";
import type { NodeEditorContext } from "./node-context";

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
  ctx,
  id,
  onChange,
  step,
}: {
  ctx: NodeEditorContext;
  /** This node's id (it cannot read itself). */
  id: string;
  onChange: (node: ViewNode) => void;
  step: Extract<ViewNode, { kind: "sql" }>;
}) {
  const reads = step.reads ?? [],
    aliases = [step.from, ...reads].filter((name) => name !== "");
  const check = checkSql(step.query, aliases);
  const names = sqlTableNames(aliases);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-2">
          <Label>Rows come from (prev)</Label>
          <LabeledSelect
            ariaLabel="SQL source node"
            className="w-64"
            onChange={(from) => {
              onChange({ ...step, from });
            }}
            options={nodeOptions(ctx.definition, ctx.infos, [id])}
            placeholder="Pick a node"
            value={step.from}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Also reads (in_&lt;node&gt;)</Label>
          <div className="flex flex-wrap items-center gap-2">
            {reads.map((read) => (
              <Button
                aria-label={`Stop reading ${read}`}
                key={read}
                onClick={() => {
                  onChange({ ...step, reads: reads.filter((other) => other !== read) });
                }}
                size="xs"
                type="button"
                variant="outline"
              >
                in_{read} ×
              </Button>
            ))}
            <LabeledSelect
              ariaLabel="Add a node to read"
              className="w-48"
              onChange={(read) => {
                if (read !== "" && !aliases.includes(read)) {
                  onChange({ ...step, reads: [...reads, read] });
                }
              }}
              options={nodeOptions(ctx.definition, ctx.infos, [id, step.from, ...reads])}
              placeholder="Add a node…"
              value=""
            />
          </div>
        </div>
      </div>
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
          rows; <code className="rounded bg-muted px-1 py-0.5">in_&lt;node&gt;</code> is a whole
          node you add under &quot;Also reads&quot;.
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
