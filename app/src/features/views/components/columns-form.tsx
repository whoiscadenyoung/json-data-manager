import type { ColumnEdit, ViewNode } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Ban, Undo2 } from "lucide-react";
import { useState } from "react";

type ColumnsNode = Extract<ViewNode, { kind: "columns" }>;

function editOf(edits: readonly ColumnEdit[], from: string): ColumnEdit | undefined {
  return edits.find((edit) => edit.from === from);
}

function withEdit(edits: ColumnEdit[], from: string, edit: ColumnEdit | undefined): ColumnEdit[] {
  const rest = edits.filter((candidate) => candidate.from !== from);
  return edit === undefined ? rest : [...rest, edit];
}

/** Commits on blur or Enter so typing does not re-key the row mid-edit. */
function RenameInput({
  from,
  to,
  onCommit,
}: {
  from: string;
  to: string;
  onCommit: (to: string) => void;
}) {
  const [draft, setDraft] = useState(to);
  const commit = (): void => {
    const next = draft.trim();
    if (next === "") {
      setDraft(to);
    } else if (next !== to) {
      onCommit(next);
    }
  };
  return (
    <Input
      aria-label={`Rename column ${from}`}
      className="h-8"
      onBlur={commit}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        }
      }}
      value={draft}
    />
  );
}

/**
 * Columns: rename and drop many columns in one node. One row per field of the
 * node it reads; untouched fields pass through unchanged. (Stack inputs have
 * the same edits per input, with the Columns table of the stack.)
 */
export function ColumnsForm({
  fields,
  node,
  onChange,
}: {
  /** The fields of the rows reaching this node (undefined = unknown). */
  fields: string[] | undefined;
  node: ColumnsNode;
  onChange: (node: ViewNode) => void;
}) {
  if (fields === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        Pick the node to read first, and run it if it is a view, to see its columns.
      </p>
    );
  }
  const set = (from: string, edit: ColumnEdit | undefined): void => {
    onChange({ ...node, edits: withEdit(node.edits, from, edit) });
  };
  const dropped = node.edits.filter((edit) => "exclude" in edit).length;
  return (
    <div className="flex flex-col gap-2">
      <Label>Columns</Label>
      <p className="text-xs text-muted-foreground">
        {node.edits.length === 0
          ? "Rename a column or drop the ones you don't need."
          : `${node.edits.length} edited, ${dropped} dropped.`}
      </p>
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_2rem] items-center gap-2">
        {fields.map((field) => {
          const edit = editOf(node.edits, field);
          const isDropped = edit !== undefined && "exclude" in edit;
          const renamed = edit !== undefined && "as" in edit ? edit.as : field;
          return (
            <div className="contents" key={field}>
              <span
                className={isDropped ? "truncate text-sm line-through" : "truncate text-sm"}
                title={field}
              >
                {field}
              </span>
              {isDropped ? (
                <span className="text-xs text-muted-foreground">Dropped</span>
              ) : (
                <RenameInput
                  from={field}
                  key={`${field}:${renamed}`}
                  onCommit={(to) => {
                    set(field, to === field ? undefined : { from: field, as: to });
                  }}
                  to={renamed}
                />
              )}
              <Button
                aria-label={isDropped ? `Keep ${field}` : `Drop ${field}`}
                onClick={() => {
                  set(field, isDropped ? undefined : { from: field, exclude: true });
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {isDropped ? <Undo2 /> : <Ban />}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
