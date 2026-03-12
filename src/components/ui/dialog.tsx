import { Dialog } from "@base-ui/react/dialog";
import { cn } from "#/lib/utils";

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  destructive = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  destructive?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 transition-opacity duration-150" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2",
            "bg-background border border-border rounded-lg shadow-lg p-6",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-95 data-[starting-style]:scale-95",
            "transition-all duration-150",
          )}
        >
          <Dialog.Title className="text-base font-semibold text-foreground mb-2">
            {title}
          </Dialog.Title>
          {description && (
            <Dialog.Description className="text-sm text-muted-foreground mb-6">
              {description}
            </Dialog.Description>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close
              className={cn(
                "inline-flex items-center justify-center rounded-md border border-border px-3 h-7 text-xs font-medium",
                "bg-background hover:bg-muted transition-colors",
              )}
            >
              {cancelLabel}
            </Dialog.Close>
            <button
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
              className={cn(
                "inline-flex items-center justify-center rounded-md px-3 h-7 text-xs font-medium transition-colors",
                destructive
                  ? "bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/30"
                  : "bg-primary text-primary-foreground hover:bg-primary/80",
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { ConfirmDialog };
