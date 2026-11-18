import type { Step } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Ban, Undo2 } from "lucide-react";
import { useState } from "react";

import {
  deriveColumns,
  mapCell,
  renameColumn,
  suggestMerges,
  toggleExclude,
  type AppendMember,
  type ColumnCell,
  type ColumnRow,
} from "../lib/append-columns";
import { LabeledSelect } from "./labeled-select";

type AppendStep = Extract<Step, { kind: "append" }>;

const NONE = "__none__";

function statusText(row: ColumnRow): string {
  if (row.status === "excluded") {
    return "Excluded";
  }
  const base = row.status === "merged" ? "Merged" : `Only in ${row.presentIn.join(", ")}`;
  return row.renamed ? `${base} · Renamed` : base;
}

/** Commits on blur or Enter so typing does not re-key the row mid-edit. */
function RenameInput({ name, onCommit }: { name: string; onCommit: (to: string) => void }) {
  const [draft, setDraft] = useState(name);
  const commit = (): void => {
    const next = draft.trim();
    if (next === "") {
      setDraft(name);
    } else if (next !== name) {
      onCommit(next);
    }
  };
  return (
    <Input
      aria-label={`Rename column ${name}`}
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

function Cell({
  cell,
  column,
  index,
  member,
  onChange,
  step,
}: {
  cell: ColumnCell | undefined;
  column: string;
  index: number;
  member: AppendMember;
  onChange: (step: AppendStep) => void;
  step: AppendStep;
}) {
  if (cell !== undefined && cell.state === "excluded") {
    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate line-through">{cell.from}</span>
        <Button
          aria-label={`Restore ${cell.from} in ${member.label}`}
          onClick={() => {
            onChange(toggleExclude(step, index, member.edits, cell.from));
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Undo2 />
        </Button>
      </div>
    );
  }
  const options = [
    { value: NONE, label: "No field" },
    ...(member.fields ?? []).map((field) => ({ value: field, label: field })),
  ];
  return (
    <div className="flex items-center gap-1">
      <LabeledSelect
        ariaLabel={`${column} from ${member.label}`}
        className="h-8 min-w-0 flex-1"
        onChange={(value) => {
          onChange(mapCell(step, member, index, column, value === NONE ? undefined : value));
        }}
        options={options}
        placeholder="—"
        value={cell === undefined ? NONE : cell.from}
      />
      {cell !== undefined && (
        <Button
          aria-label={`Exclude ${cell.from} from ${member.label}`}
          onClick={() => {
            onChange(toggleExclude(step, index, member.edits, cell.from));
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Ban />
        </Button>
      )}
    </div>
  );
}

function ColumnLine({
  members,
  onChange,
  row,
  step,
}: {
  members: AppendMember[];
  onChange: (step: AppendStep) => void;
  row: ColumnRow;
  step: AppendStep;
}) {
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <RenameInput
          key={row.name}
          name={row.name}
          onCommit={(to) => {
            onChange(renameColumn(step, members, row, to));
          }}
        />
        <span className="text-[11px] text-muted-foreground">{statusText(row)}</span>
      </div>
      {members.map((member, index) => (
        <Cell
          cell={row.cells.find((cell) => cell.member === index)}
          column={row.name}
          index={index}
          // oxlint-disable-next-line react/no-array-index-key -- members are an ordered, unkeyed list.
          key={index}
          member={member}
          onChange={onChange}
          step={step}
        />
      ))}
    </>
  );
}

/**
 * Columns of a Stack: which fields line up across the stacked datasets, with
 * rename / re-map / exclude. Untouched fields pass through unchanged.
 */
export function AppendColumns({
  members,
  onChange,
  step,
}: {
  members: AppendMember[];
  onChange: (step: AppendStep) => void;
  step: AppendStep;
}) {
  if (members.some((member) => member.fields === undefined)) {
    return (
      <p className="text-xs text-muted-foreground">
        Pick every dataset to see how their columns line up.
      </p>
    );
  }
  const rows = deriveColumns(members);
  const merges = suggestMerges(rows);
  const template = { gridTemplateColumns: `10rem repeat(${members.length}, minmax(8rem, 1fr))` };
  return (
    <div className="flex flex-col gap-2">
      <Label>Columns</Label>
      {merges.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {merges.map((merge) => (
            <Button
              key={`${merge.into}|${merge.from}`}
              onClick={() => {
                const row = rows.find((candidate) => candidate.name === merge.from);
                if (row !== undefined) {
                  onChange(renameColumn(step, members, row, merge.into));
                }
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Merge “{merge.from}” into “{merge.into}”
            </Button>
          ))}
        </div>
      )}
      <div className="grid items-center gap-2 overflow-x-auto" style={template}>
        <span className="text-xs text-muted-foreground">Output column</span>
        {members.map((member, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- members are an ordered, unkeyed list.
          <span className="truncate text-xs text-muted-foreground" key={index} title={member.label}>
            {member.label}
          </span>
        ))}
        {rows.map((row) => (
          <ColumnLine key={row.name} members={members} onChange={onChange} row={row} step={step} />
        ))}
      </div>
    </div>
  );
}
