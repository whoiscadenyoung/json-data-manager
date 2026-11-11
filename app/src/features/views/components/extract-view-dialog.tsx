import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * Extract to view (#307): a join's inline sub-pipeline becomes its own view,
 * and the join reads that view instead. The dialog names the new view and
 * says what will happen (it also saves this view's other unsaved edits and
 * runs the new view once).
 */
export function ExtractViewDialog({
  busy,
  defaultTitle,
  dirty,
  onConfirm,
  onOpenChange,
  open,
  rightTitle,
}: {
  busy: boolean;
  defaultTitle: string;
  dirty: boolean;
  onConfirm: (title: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  rightTitle: string;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Extract to view</DialogTitle>
          <DialogDescription>
            Moves the steps on {rightTitle} into a new view and makes this join read that view. The
            result stays the same.
          </DialogDescription>
        </DialogHeader>
        <ExtractForm
          busy={busy}
          defaultTitle={defaultTitle}
          dirty={dirty}
          onCancel={() => {
            onOpenChange(false);
          }}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
}

function ExtractForm({
  busy,
  defaultTitle,
  dirty,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  defaultTitle: string;
  dirty: boolean;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const missing = title.trim() === "" ? "Give the new view a title." : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="extract-view-title">
          New view title <span className="text-destructive">*</span>
        </Label>
        <Input
          id="extract-view-title"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          value={title}
        />
      </div>
      <ul className="list-disc pl-5 text-xs text-muted-foreground">
        <li>The new view is created in this project and run once so its rows exist.</li>
        <li>This view is saved{dirty ? " (including your other unsaved changes)" : ""}.</li>
        <li>
          Refresh the new view when its inputs change: this view reads its saved rows, not the
          original steps.
        </li>
      </ul>
      {missing !== undefined && <p className="text-xs text-muted-foreground">{missing}</p>}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          disabled={missing !== undefined || busy}
          onClick={() => {
            onConfirm(title.trim());
          }}
          type="button"
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Extract
        </Button>
      </div>
    </div>
  );
}
