import type { ViewDefinition } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Card, CardContent, CardDescription } from "@caden/ui/components/card";
import { Checkbox } from "@caden/ui/components/checkbox";
import { Input } from "@caden/ui/components/input";
import { ArrowDown, ArrowUp } from "lucide-react";

import {
  moveRow,
  outputFieldsOf,
  outputRowsOf,
  patchRow,
  renameNote,
  rowProblems,
  setKept,
} from "../lib/output-model";
import type { OutputRow } from "../lib/output-model";
import { LabeledSelect } from "./labeled-select";

function isKept(row: OutputRow | undefined): boolean {
  return row !== undefined && row.kept;
}

const EMPTY_OPTIONS = [
  { value: "keep", label: "Keep empty fields (as null)" },
  { value: "omit", label: "Omit empty fields" },
];

/**
 * The Output card (issue #303): for every final field a key, a label, a
 * hidden flag and its place in the order. Labels and hidden flags live in
 * the definition's `output`, next to the keys. A rename is never silent: the
 * original field name is shown beside the new key.
 */
export function OutputCard({
  draft,
  expanded,
  fields,
  onChange,
  onSelect,
}: {
  draft: ViewDefinition;
  expanded: boolean;
  fields: string[] | undefined;
  onChange: (next: ViewDefinition) => void;
  onSelect: () => void;
}) {
  const rows = outputRowsOf(draft.output, fields),
    problems = rowProblems(rows),
    keptCount = rows.filter((row) => row.kept).length,
    keepsAll = draft.output.fields.length === 0,
    commit = (next: OutputRow[]): void => {
      onChange({ ...draft, output: { ...draft.output, fields: outputFieldsOf(next, fields) } });
    };
  return (
    <Card className={expanded ? "border-primary/40" : undefined}>
      <button
        aria-expanded={expanded}
        className="flex flex-col items-start px-4 pt-3 pb-3 text-left"
        onClick={onSelect}
        type="button"
      >
        <span className="text-sm font-medium">Output fields</span>
        <span className="text-xs text-muted-foreground">
          {keepsAll
            ? `All fields${fields === undefined ? "" : ` (${fields.length})`}`
            : `${keptCount} of ${rows.length} fields kept`}
        </span>
      </button>
      {expanded && (
        <CardContent className="flex flex-col gap-3">
          {fields === undefined ? (
            <p className="text-sm text-muted-foreground">
              The final fields aren&apos;t known until the steps are complete.
            </p>
          ) : (
            <>
              <CardDescription>
                Rename a field, give it a label, hide it from tooltips and exports, or reorder it.
                Untick a field to leave it out of the saved rows.
              </CardDescription>
              <ul className="flex flex-col gap-2">
                {rows.map((row, index) => (
                  <OutputRowEditor
                    first={index === 0 || !isKept(rows[index - 1])}
                    key={row.from}
                    last={index === rows.length - 1 || !isKept(rows[index + 1])}
                    onChange={(patch) => {
                      commit(patchRow(rows, index, patch));
                    }}
                    onKeep={(kept) => {
                      commit(setKept(rows, index, kept));
                    }}
                    onMove={(direction) => {
                      commit(moveRow(rows, index, direction));
                    }}
                    problems={problems[index]}
                    row={row}
                  />
                ))}
              </ul>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Empty fields in exports
                </span>
                <LabeledSelect
                  ariaLabel="Empty fields"
                  className="w-64"
                  onChange={(value) => {
                    onChange({
                      ...draft,
                      output: {
                        ...draft.output,
                        emptyFields: value === "omit" ? "omit" : "keep",
                      },
                    });
                  }}
                  options={EMPTY_OPTIONS}
                  placeholder="Empty fields"
                  value={draft.output.emptyFields}
                />
                <span className="text-xs text-muted-foreground">
                  The default for new export profiles. Each profile can override it.
                </span>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function OutputRowEditor({
  first,
  last,
  onChange,
  onKeep,
  onMove,
  problems,
  row,
}: {
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<OutputRow>) => void;
  onKeep: (kept: boolean) => void;
  onMove: (direction: -1 | 1) => void;
  problems: ReturnType<typeof rowProblems>[number] | undefined;
  row: OutputRow;
}) {
  const note = renameNote(row);
  return (
    <li className="flex flex-col gap-1 rounded-md border px-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          aria-label={`Keep ${row.from}`}
          checked={row.kept}
          onCheckedChange={(checked) => {
            onKeep(checked);
          }}
        />
        {row.kept ? (
          <>
            <Input
              aria-label={`Key for ${row.from}`}
              className="h-8 w-40"
              onChange={(event) => {
                onChange({ key: event.target.value });
              }}
              value={row.key}
            />
            <Input
              aria-label={`Label for ${row.from}`}
              className="h-8 w-40"
              onChange={(event) => {
                onChange({ label: event.target.value });
              }}
              placeholder="Label"
              value={row.label}
            />
            <div className="flex items-center gap-1.5 text-xs">
              <Checkbox
                aria-label={`Hide ${row.from}`}
                checked={row.hidden}
                onCheckedChange={(checked) => {
                  onChange({ hidden: checked });
                }}
              />
              <span>Hidden</span>
            </div>
            <Button
              aria-label={`Move ${row.from} up`}
              disabled={first}
              onClick={() => {
                onMove(-1);
              }}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              aria-label={`Move ${row.from} down`}
              disabled={last}
              onClick={() => {
                onMove(1);
              }}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowDown className="size-3.5" />
            </Button>
          </>
        ) : (
          <span className="text-sm text-muted-foreground line-through">{row.from}</span>
        )}
      </div>
      {note !== undefined && (
        <p className="text-xs text-muted-foreground">
          Renamed: <span className="font-mono">{note}</span>
        </p>
      )}
      {problems !== undefined && problems.empty && (
        <p className="text-xs text-destructive">Every kept field needs a key.</p>
      )}
      {problems !== undefined && problems.duplicate && (
        <p className="text-xs text-destructive">Another field already uses the key “{row.key}”.</p>
      )}
      {problems !== undefined && problems.arcgis !== undefined && (
        <p className="text-xs text-amber-600">{problems.arcgis}</p>
      )}
    </li>
  );
}
