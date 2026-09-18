import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";

/**
 * Shared "delete this? it cascades to links" confirmation for the dashboard
 * panels. `name` undefined closes the dialog; when set, it names the row
 * being deleted.
 */
export function ConfirmDeleteDialog({
  description,
  entityLabel,
  isPending,
  name,
  onCancel,
  onConfirm,
}: {
  description: string;
  entityLabel: string;
  isPending: boolean;
  name?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={name !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {name === undefined ? `Delete ${entityLabel}` : `Delete "${name}"?`}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onCancel();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isPending}
            onClick={() => {
              onConfirm();
            }}
          >
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
