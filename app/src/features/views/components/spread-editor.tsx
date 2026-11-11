import type { MultiMatch } from "@caden/data-core/views";
import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";

import { distinctFieldValuesQueryOptions } from "@/lib/store/view-reads";

import { proposeSpreadColumns } from "../lib/view-model";
import { LabeledSelect } from "./labeled-select";

type Spread = Extract<MultiMatch, { mode: "spread" }>;

const fieldOptions = (fields: string[]) => fields.map((field) => ({ value: field, label: field }));

/**
 * Spread: one column per category of a field (e.g. one link column per link
 * type). The columns are declared, so the view's shape never depends on the
 * data. Proposals come from the distinct values of the category field in the
 * right dataset; categories the data has but no column covers are listed from
 * the join's diagnostics, and never silently add columns.
 */
export function SpreadEditor({
  existingFields,
  onChange,
  rightDatasetId,
  rightFields,
  spread,
  undeclared,
}: {
  /** Field names already in the rows (a new column must not reuse one by accident). */
  existingFields: string[];
  onChange: (spread: Spread) => void;
  rightDatasetId: string;
  rightFields: string[];
  spread: Spread;
  /** Categories the join's diagnostics found with no declared column. */
  undeclared: string[];
}) {
  const values = useQuery(distinctFieldValuesQueryOptions(rightDatasetId, spread.by)),
    proposals = proposeSpreadColumns(values.data ?? [], spread.columns, existingFields),
    missing = proposeSpreadColumns(undeclared, spread.columns, existingFields),
    setColumns = (columns: Spread["columns"]): void => {
      onChange({ ...spread, columns });
    };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Category field</Label>
          <LabeledSelect
            ariaLabel="Spread category field"
            onChange={(by) => {
              onChange({ ...spread, by });
            }}
            options={fieldOptions(rightFields)}
            placeholder="Which field names the columns?"
            value={spread.by}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Value field</Label>
          <LabeledSelect
            ariaLabel="Spread value field"
            onChange={(value) => {
              onChange({ ...spread, value });
            }}
            options={fieldOptions(rightFields)}
            placeholder="Which field fills them?"
            value={spread.value}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Columns to add</Label>
        {spread.columns.map((column, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- spread columns are an ordered, unkeyed list.
          <div className="flex flex-wrap items-center gap-2" key={index}>
            <Input
              aria-label={`Spread column ${index + 1} category`}
              className="w-44"
              onChange={(event) => {
                setColumns(
                  spread.columns.map((c, i) =>
                    i === index ? { ...c, category: event.target.value } : c,
                  ),
                );
              }}
              placeholder="Category value"
              value={column.category}
            />
            <span className="text-sm text-muted-foreground">becomes</span>
            <Input
              aria-label={`Spread column ${index + 1} name`}
              className="w-44"
              onChange={(event) => {
                setColumns(
                  spread.columns.map((c, i) =>
                    i === index ? { ...c, as: event.target.value } : c,
                  ),
                );
              }}
              placeholder="Column name"
              value={column.as}
            />
            <Button
              aria-label={`Remove spread column ${index + 1}`}
              onClick={() => {
                setColumns(spread.columns.filter((_, i) => i !== index));
              }}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setColumns([...spread.columns, ...proposals]);
            }}
            disabled={proposals.length === 0}
            size="sm"
            title={
              spread.by === ""
                ? "Pick the category field first."
                : proposals.length === 0
                  ? "Every value found already has a column."
                  : undefined
            }
            type="button"
            variant="outline"
          >
            <Plus className="h-3.5 w-3.5" />
            {proposals.length > 0
              ? `Add proposed columns (${proposals.length})`
              : "Add proposed columns"}
          </Button>
          <Button
            onClick={() => {
              setColumns([...spread.columns, { category: "", as: "" }]);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Add a column by hand
          </Button>
        </div>
        {proposals.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Found in the data:{" "}
            {proposals.map((proposal) => `${proposal.category} → ${proposal.as}`).join(", ")}
          </p>
        )}
      </div>

      {missing.length > 0 && (
        <output className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          <p>
            {missing.length === 1 ? "1 category has" : `${missing.length} categories have`} no
            column and {missing.length === 1 ? "is" : "are"} left out:{" "}
            <span className="font-medium">
              {missing.map((column) => column.category).join(", ")}
            </span>
          </p>
          <Button
            className="w-fit"
            onClick={() => {
              setColumns([...spread.columns, ...missing]);
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            Add columns for them
          </Button>
        </output>
      )}
    </div>
  );
}
