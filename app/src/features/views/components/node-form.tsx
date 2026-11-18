import type { ViewNode } from "@caden/data-core/views";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import { Card, CardContent } from "@caden/ui/components/card";
import { Input } from "@caden/ui/components/input";
import { cn } from "@caden/ui/lib/utils";
import { Flag, Trash2, Workflow } from "lucide-react";

import { stepKindVisual } from "@/features/view-graphs";

import { nodeDiagnosticsOf, type NodeDiagnostics } from "../lib/diagnostics";
import {
  errorLabel,
  errorsForNode,
  nodeLabel,
  nodeProblem,
  nodeSummary,
  NODE_TITLES,
  removeBlocker,
  repointRight,
  type AddableKind,
} from "../lib/view-model";
import { CalculateForm } from "./calculate-form";
import { ColumnsForm } from "./columns-form";
import type { NodeEditorContext } from "./node-context";
import { FilterForm, GroupByForm, JoinForm } from "./node-forms";
import { AddNodeMenu } from "./node-list";
import { SqlForm } from "./sql-form";
import { StackForm } from "./stack-form";

function undeclaredOf(diagnostics: NodeDiagnostics | undefined): string[] | undefined {
  if (diagnostics === undefined || diagnostics.join === undefined) {
    return undefined;
  }
  const { spread } = diagnostics.join;
  return spread === undefined ? undefined : spread.undeclaredCategories;
}

function NodeNote({ diagnostics }: { diagnostics: NodeDiagnostics }) {
  return (
    <p className="mb-3 text-xs text-muted-foreground" data-testid="node-note">
      {diagnostics.rowsIn.toLocaleString()} rows in, {diagnostics.rowsOut.toLocaleString()} out
      {diagnostics.fieldsAdded.length > 0 && `. Adds ${diagnostics.fieldsAdded.join(", ")}`}
      {diagnostics.fieldsRemoved.length > 0 && `. Removes ${diagnostics.fieldsRemoved.join(", ")}`}
    </p>
  );
}

/** The part of a node's validation errors the card lists (expression / SQL errors show in their own form). */
function cardMessages(ctx: NodeEditorContext, id: string, node: ViewNode): string[] {
  const path = `nodes.${id}`;
  const own = errorsForNode(ctx.errors, id).filter(
    (error) =>
      !(node.kind === "calculate" && error.path.endsWith(".expr")) &&
      !(node.kind === "sql" && error.path === `${path}.query`),
  );
  return [
    ...new Set(
      own.map((error) => {
        const label = errorLabel(error.path, path);
        return label === "" ? error.message : `${label}: ${error.message}`;
      }),
    ),
  ];
}

function inputFieldsOf(ctx: NodeEditorContext, node: ViewNode): string[] | undefined {
  switch (node.kind) {
    case "source":
    case "stack":
      return undefined;
    case "join":
      return ctx.fields.get(node.left);
    default:
      return ctx.fields.get(node.from);
  }
}

function NodeBody({
  ctx,
  diagnostics,
  id,
  node,
  onChange,
}: {
  ctx: NodeEditorContext;
  diagnostics: NodeDiagnostics | undefined;
  id: string;
  node: ViewNode;
  onChange: (node: ViewNode) => void;
}) {
  const fields = inputFieldsOf(ctx, node);
  switch (node.kind) {
    case "filter":
      return <FilterForm fields={fields ?? []} onChange={onChange} step={node} />;
    case "groupBy":
      return <GroupByForm fields={fields ?? []} onChange={onChange} step={node} />;
    case "columns":
      return <ColumnsForm fields={fields} node={node} onChange={onChange} />;
    case "calculate":
      return (
        <CalculateForm
          fieldTypes={ctx.fieldTypes}
          fields={fields}
          node={node}
          onChange={onChange}
        />
      );
    case "stack":
      return <StackForm ctx={ctx} id={id} node={node} onChange={onChange} />;
    case "sql":
      return <SqlForm ctx={ctx} id={id} onChange={onChange} step={node} />;
    case "join":
      return (
        <JoinForm
          ctx={ctx}
          id={id}
          onChange={onChange}
          onPickRight={(right) => {
            onChange(
              repointRight(node, right, {
                old: nodeLabel(ctx.definition, ctx.infos, node.right),
                next: nodeLabel(ctx.definition, ctx.infos, right),
              }),
            );
          }}
          step={node}
          undeclaredCategories={undeclaredOf(diagnostics)}
        />
      );
    default:
      return (
        <p className="text-sm text-muted-foreground">
          This node type has no form yet. It still runs as saved.
        </p>
      );
  }
}

/**
 * The selected node's settings: its label, its kind's form, the problems and
 * diagnostics that concern it, and the actions that change the graph around
 * it (branch from it, make it the result, remove it).
 */
export function NodeForm({
  ctx,
  id,
  isResult,
  onBranch,
  onChange,
  extractBlocked,
  onExtract,
  onMakeResult,
  onRemove,
}: {
  ctx: NodeEditorContext;
  id: string;
  isResult: boolean;
  onBranch: (kind: AddableKind) => void;
  onChange: (node: ViewNode) => void;
  /** Why extracting is unavailable right now (shown as the button's reason). */
  extractBlocked?: string | undefined;
  /** "Extract to view": this node and what it reads become their own view. */
  onExtract: () => void;
  onMakeResult: () => void;
  onRemove: () => void;
}) {
  const node = ctx.definition.nodes[id];
  if (node === undefined) {
    return null;
  }
  const visual = stepKindVisual(node.kind);
  const problem = nodeProblem(node);
  const messages = cardMessages(ctx, id, node);
  const diagnostics = nodeDiagnosticsOf(ctx.diagnostics, id);
  const blocker = removeBlocker(ctx.definition, id);
  return (
    <Card className={cn(messages.length > 0 && "border-destructive/50")}>
      <div className="flex items-center gap-2 px-4 pt-3">
        <span
          className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", visual.tone)}
        >
          <visual.icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-muted-foreground">
            {NODE_TITLES[node.kind]} · <code>{id}</code>
          </span>
          <span className="max-w-full truncate text-xs text-muted-foreground">
            {nodeSummary(ctx.definition, ctx.infos, id)}
          </span>
        </div>
        {isResult && (
          <Badge variant="secondary">
            <Flag className="mr-1 size-3" />
            Result
          </Badge>
        )}
        {problem !== undefined ? (
          <Badge variant="secondary">Needs input</Badge>
        ) : (
          messages.length > 0 && <Badge variant="destructive">Problem</Badge>
        )}
      </div>
      <CardContent className="flex flex-col gap-3 pt-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" htmlFor="node-label">
            Name
          </label>
          <Input
            className="h-8"
            id="node-label"
            onChange={(event) => {
              onChange({ ...node, label: event.target.value });
            }}
            placeholder={id}
            value={node.label ?? ""}
          />
        </div>
        {problem !== undefined && <p className="text-xs text-destructive">{problem}</p>}
        {messages.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-destructive" role="alert">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        {diagnostics !== undefined && <NodeNote diagnostics={diagnostics} />}
        <NodeBody ctx={ctx} diagnostics={diagnostics} id={id} node={node} onChange={onChange} />
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <AddNodeMenu label="Branch from here" onAdd={onBranch} />
          {!isResult && (
            <Button onClick={onMakeResult} size="sm" type="button" variant="outline">
              <Workflow className="mr-1.5 h-3.5 w-3.5" />
              Use as the result
            </Button>
          )}
          <Button
            disabled={extractBlocked !== undefined}
            onClick={onExtract}
            size="sm"
            title={
              extractBlocked ??
              "Move this node and everything it reads into its own view, and read that view here."
            }
            type="button"
            variant="outline"
          >
            Extract to view
          </Button>
          <Button
            aria-label={`Remove ${id}`}
            disabled={blocker !== undefined}
            onClick={onRemove}
            size="sm"
            title={blocker ?? "Remove this node and reconnect what reads it"}
            type="button"
            variant="ghost"
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Remove
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
