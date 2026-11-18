import type { AppendTag, ViewNode } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Plus, Trash2 } from "lucide-react";

import { stackMembers } from "../lib/stack-columns";
import { nodeLabel, nodeOptions } from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";
import type { NodeEditorContext } from "./node-context";
import { StackColumns } from "./stack-columns";

type StackNode = Extract<ViewNode, { kind: "stack" }>;

/** Tags are typed as text; digits-only text becomes a number (a fiscal year stays numeric). */
function parseTag(text: string): AppendTag | undefined {
  if (text === "") {
    return undefined;
  }
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

function tagText(tag: AppendTag | undefined): string {
  return tag === undefined || tag === null ? "" : String(tag);
}

/**
 * Stack: one table of the nodes whose rows are added together. Each input is
 * any node (clean a dataset first, then stack the cleaned node), can stamp a
 * tag (e.g. the fiscal year) into one field, and carries its own column edits.
 * Geometry travels with every row.
 */
export function StackForm({
  ctx,
  id,
  node,
  onChange,
}: {
  ctx: NodeEditorContext;
  id: string;
  node: StackNode;
  onChange: (node: ViewNode) => void;
}) {
  const setInput = (index: number, patch: Partial<StackNode["inputs"][number]>): void => {
    onChange({
      ...node,
      inputs: node.inputs.map((input, i) => (i === index ? { ...input, ...patch } : input)),
    });
  };
  const taken = node.inputs.map((input) => input.node);
  const tagMissing =
    node.tagField !== undefined && node.inputs.some((input) => input.tag === undefined);
  const members = stackMembers(
    node,
    (other) => ctx.fields.get(other),
    (other) => nodeLabel(ctx.definition, ctx.infos, other),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="stack-tag-field">Tag field (optional)</Label>
        <Input
          className="w-56"
          id="stack-tag-field"
          onChange={(event) => {
            const value = event.target.value;
            onChange({ ...node, tagField: value === "" ? undefined : value });
          }}
          placeholder="fiscal_year"
          value={node.tagField ?? ""}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label>Nodes stacked together</Label>
        <div className="grid grid-cols-[1fr_6rem_2rem] items-center gap-2 text-xs text-muted-foreground">
          <span>Node</span>
          <span>Tag</span>
          <span />
        </div>
        <div className="grid grid-cols-[1fr_6rem_2rem] items-center gap-2">
          {node.inputs.map((input, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- inputs are an ordered, unkeyed list.
            <div className="contents" key={index}>
              <LabeledSelect
                ariaLabel={`Stacked node ${index + 1}`}
                onChange={(next) => {
                  setInput(index, { node: next });
                }}
                options={nodeOptions(ctx.definition, ctx.infos, [
                  id,
                  ...taken.filter((other) => other !== input.node),
                ])}
                placeholder="Pick a node"
                value={input.node}
              />
              <Input
                aria-label={`Tag for stacked node ${index + 1}`}
                onChange={(event) => {
                  setInput(index, { tag: parseTag(event.target.value) });
                }}
                placeholder="2023"
                value={tagText(input.tag)}
              />
              <Button
                aria-label={`Remove stacked node ${index + 1}`}
                onClick={() => {
                  onChange({ ...node, inputs: node.inputs.filter((_, i) => i !== index) });
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        {tagMissing && (
          <p className="text-xs text-muted-foreground">
            Rows from a node without a tag get no {node.tagField} value.
          </p>
        )}
        <Button
          className="w-fit"
          onClick={() => {
            onChange({ ...node, inputs: [...node.inputs, { node: "" }] });
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-3.5 w-3.5" />
          Add node
        </Button>
      </div>
      <StackColumns members={members} node={node} onChange={onChange} />
    </div>
  );
}
