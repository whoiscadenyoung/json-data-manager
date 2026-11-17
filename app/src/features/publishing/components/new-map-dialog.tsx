import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import { Textarea } from "@caden/ui/components/textarea";
import { useRef, useState } from "react";

/** The new-map form: a name (required) and an optional description. The editor opens once it is created. */
export function NewMapDialog({
  busy,
  onOpenChange,
  onSubmit,
}: {
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { description: string; name: string }) => void;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [missingName, setMissingName] = useState(false),
    nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="sm:max-w-md" initialFocus={nameRef}>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === "") {
              setMissingName(true);
              if (nameRef.current !== null) {
                nameRef.current.focus();
              }
              return;
            }
            onSubmit({ description: description.trim(), name: name.trim() });
          }}
        >
          <DialogHeader>
            <DialogTitle>New map</DialogTitle>
            <DialogDescription>
              The map opens in the editor, where you add this project's datasets as layers.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-map-name">
              Name <span className="font-normal text-muted-foreground">(required)</span>
            </Label>
            <Input
              aria-describedby={missingName ? "new-map-name-error" : undefined}
              aria-invalid={missingName}
              id="new-map-name"
              maxLength={120}
              onChange={(event) => {
                setName(event.target.value);
                setMissingName(false);
              }}
              placeholder="Parks overview"
              ref={nameRef}
              value={name}
            />
            {missingName && (
              <p className="text-xs text-destructive" id="new-map-name-error">
                A map needs a name.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-map-description">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="new-map-description"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
              rows={2}
              value={description}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? "Creating…" : "Create map"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
