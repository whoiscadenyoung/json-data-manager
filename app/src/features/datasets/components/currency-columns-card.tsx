import { currencyFieldsOf, detectCurrencyColumns } from "@caden/data-core/currency";
import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@caden/ui/components/card";
import { Checkbox } from "@caden/ui/components/checkbox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { fetchDatasetEntryRows } from "#/lib/dataset-rows-pg";
import { errorMessage } from "#/lib/errors";
import * as datasetsStore from "#/lib/store/datasets";
import type { DatasetRow } from "#/lib/store/datasets";
import * as entriesStore from "#/lib/store/entries";

import {
  currencySchemaOf,
  planBlocker,
  planCurrencyTyping,
  rewriteValuesOf,
  textColumnsOf,
  type CurrencyPlan,
  type CurrencyPlanRow,
} from "../lib/currency-typing";

const SHOWN_FAILURES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordsOf(rows: readonly CurrencyPlanRow[]): Record<string, unknown>[] {
  return rows.map((row) => (isRecord(row.data) ? row.data : {}));
}

function PlanPreview({
  plan,
  clearFailures,
  onClearFailures,
}: {
  plan: CurrencyPlan;
  clearFailures: boolean;
  onClearFailures: (next: boolean) => void;
}) {
  const symbol =
    plan.symbol === null ? "mixed symbols" : plan.symbol === "" ? "no symbol" : plan.symbol;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm">
      <p>
        <code className="font-mono">{plan.field}</code>: {plan.converted.toLocaleString()} values
        become numbers ({symbol})
        {plan.blanks > 0 ? `, ${plan.blanks.toLocaleString()} blank cells are cleared` : ""}.
      </p>
      {plan.failures.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-destructive">
            {plan.failures.length === 1
              ? "1 value doesn't read as an amount:"
              : `${plan.failures.length.toLocaleString()} values don't read as amounts:`}
          </p>
          <ul className="list-inside list-disc text-xs text-muted-foreground">
            {plan.failures.slice(0, SHOWN_FAILURES).map((failure) => (
              <li key={failure.id}>
                {JSON.stringify(failure.value)} — {failure.reason}
              </li>
            ))}
            {plan.failures.length > SHOWN_FAILURES ? (
              <li>and {(plan.failures.length - SHOWN_FAILURES).toLocaleString()} more</li>
            ) : null}
          </ul>
          <label className="flex items-center gap-2 text-xs" htmlFor="currency-clear-failures">
            <Checkbox
              id="currency-clear-failures"
              checked={clearFailures}
              onCheckedChange={(checked) => {
                onClearFailures(checked);
              }}
            />
            Clear these values (they are removed, not set to 0)
          </label>
        </div>
      ) : null}
    </div>
  );
}

interface ScanState {
  suggested: string[];
  plan: CurrencyPlan | undefined;
  blocker: string | undefined;
}

/** Suggestions, the preview plan and its blocker for the loaded rows (pure; keeps the card simple). */
function scanStateOf(
  rows: readonly CurrencyPlanRow[] | undefined,
  field: string | undefined,
  textColumns: readonly string[],
  clearFailures: boolean,
): ScanState {
  if (rows === undefined) {
    return { blocker: undefined, plan: undefined, suggested: [] };
  }
  const suggested = detectCurrencyColumns(recordsOf(rows))
      .map((guess) => guess.field)
      .filter((name) => textColumns.includes(name)),
    plan = field === undefined ? undefined : planCurrencyTyping(rows, field);
  return {
    blocker: plan === undefined ? undefined : planBlocker(plan, clearFailures),
    plan,
    suggested,
  };
}

/**
 * "Type as currency" on the Structure tab (issue #292). Reads every row on
 * request, previews what the shared parser would do, and only then rewrites
 * the column (`rewrite_entry_field`) and stores `type: number` +
 * `x-currency`. Editors only; views never show it (their rows come from runs).
 */
export function CurrencyColumnsCard({ dataset }: { dataset: DatasetRow }) {
  const queryClient = useQueryClient(),
    [scanning, setScanning] = useState(false),
    rowsQuery = useQuery({
      enabled: scanning,
      queryFn: async (): Promise<CurrencyPlanRow[]> => await fetchDatasetEntryRows(dataset.id),
      queryKey: ["pg:entries", "currency-scan", dataset.id, dataset.updatedAt],
      staleTime: 60_000,
    }),
    [field, setField] = useState<string | undefined>(),
    [clearFailures, setClearFailures] = useState(false),
    [applying, setApplying] = useState(false),
    current = currencyFieldsOf(dataset.jsonSchema),
    textColumns = textColumnsOf(dataset.jsonSchema),
    rows = rowsQuery.data,
    { suggested, plan, blocker } = scanStateOf(rows, field, textColumns, clearFailures);

  const apply = async (): Promise<void> => {
    if (rows === undefined || plan === undefined || blocker !== undefined) {
      return;
    }
    setApplying(true);
    try {
      const values = rewriteValuesOf(rows, plan.field, clearFailures),
        changed = await entriesStore.rewriteField({
          datasetId: dataset.id,
          field: plan.field,
          values,
        });
      if (changed < values.length) {
        throw new Error(
          `Only ${changed.toLocaleString()} of ${values.length.toLocaleString()} rows could be rewritten — you may not have edit access. Nothing else was changed; run it again once you do.`,
        );
      }
      const updated = await datasetsStore.update({
        datasetId: dataset.id,
        schema: currencySchemaOf(dataset.jsonSchema, plan, clearFailures, rows.length),
      });
      if (updated === 0) {
        throw new Error(
          "The rows were rewritten but the schema update was refused (locked dataset).",
        );
      }
      toast.success(`"${plan.field}" is now a currency column.`);
      setField(undefined);
      setClearFailures(false);
      void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:entries"] });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't type the column."));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" />
          Currency columns
        </CardTitle>
        <CardDescription>
          Amounts stored as text (" $1,492,204 ", "(500)") can't be summed or sorted. Typing a
          column rewrites its values as numbers and shows them with the currency symbol; exports
          keep the plain number.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {Object.keys(current).length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            Currency:
            {Object.entries(current).map(([name, symbol]) => (
              <Badge key={name} variant="secondary">
                {name}
                {symbol === "" ? "" : ` (${symbol})`}
              </Badge>
            ))}
          </div>
        ) : null}
        {!scanning ? (
          <Button
            className="self-start"
            disabled={textColumns.length === 0}
            onClick={() => {
              setScanning(true);
            }}
            size="sm"
            variant="outline"
          >
            Check text columns
          </Button>
        ) : rows === undefined ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the rows…
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            {textColumns.map((name) => (
              <Button
                key={name}
                onClick={() => {
                  setField(name);
                  setClearFailures(false);
                }}
                size="sm"
                variant={
                  field === name ? "default" : suggested.includes(name) ? "outline" : "ghost"
                }
              >
                {name}
                {suggested.includes(name) ? " · looks like currency" : ""}
              </Button>
            ))}
          </div>
        )}
        {plan === undefined ? null : (
          <>
            <PlanPreview
              clearFailures={clearFailures}
              onClearFailures={setClearFailures}
              plan={plan}
            />
            <Button
              className="self-start"
              disabled={blocker !== undefined || applying}
              onClick={() => void apply()}
              size="sm"
              title={blocker}
            >
              {applying ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Type "{plan.field}" as currency
            </Button>
            {blocker === undefined ? null : (
              <p className="text-xs text-muted-foreground">{blocker}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
