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
 * being deleted. `title`/`confirmLabel` re-word the action for flows where
 * "delete" isn't the verb (e.g. retiring a frozen version).
 */
export function ConfirmDeleteDialog({
  confirmLabel = "Delete",
  description,
  entityLabel,
  isPending,
  name,
  title,
  onCancel,
  onConfirm,
}: {
  confirmLabel?: string;
  description: string;
  entityLabel: string;
  isPending: boolean;
  name?: string;
  title?: string;
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
            {title ??
              (name === undefined ? `Delete ${entityLabel}` : `Delete "${name}"?`)}
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
            {isPending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
