import { FileSpreadsheet } from "lucide-react";

import { Button } from "./primitives/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./primitives/card.js";

export interface SheetPickerSheet {
  name: string;
  rowCount: number;
}

export interface SheetPickerProps {
  fileName: string;
  sheets: SheetPickerSheet[];
  onSelect: (sheetName: string) => void;
  onCancel: () => void;
}

/** Shown when an uploaded workbook has more than one sheet — the user picks which one to import before it goes any further into the pipeline. */
export function SheetPicker({ fileName, sheets, onSelect, onCancel }: SheetPickerProps) {
  return (
    <Card className="max-w-xl mx-auto">
      <CardHeader>
        <CardTitle>Choose a sheet</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{fileName}</span> has {sheets.length}{" "}
          sheets. Pick the one to import.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {sheets.map((sheet) => (
          <button
            key={sheet.name}
            type="button"
            className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onSelect(sheet.name);
            }}
          >
            <span className="flex items-center gap-2 min-w-0">
              <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium">{sheet.name}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {sheet.rowCount} row{sheet.rowCount === 1 ? "" : "s"}
            </span>
          </button>
        ))}
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onCancel}>
          Cancel
        </Button>
      </CardContent>
    </Card>
  );
}
