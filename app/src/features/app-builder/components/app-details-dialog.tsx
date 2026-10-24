import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import { APP_LIMITS } from "#convex/appBuilder/validators";

/**
 * Title + description, for both "New app" (no `appId`: creates, then hands
 * the new id to `onSaved`) and "Edit details" (patches the existing app).
 * The title is the only required field (the app-wide rule).
 */
export function AppDetailsDialog({
  appId,
  initial,
  open,
  onOpenChange,
  onSaved,
}: {
  appId?: string;
  initial?: { title: string; description?: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (appId: string) => void | Promise<void>;
}) {
  const create = useMutation(api.appBuilder.apps.create),
    updateDetails = useMutation(api.appBuilder.apps.updateDetails),
    [title, setTitle] = useState(initial === undefined ? "" : initial.title),
    [description, setDescription] = useState(
      initial === undefined ? "" : (initial.description ?? ""),
    ),
    [submitting, setSubmitting] = useState(false),
    titleMissing = title.trim() === "";

  const submit = async () => {
    if (titleMissing) {
      return;
    }
    setSubmitting(true);
    try {
      let savedId = appId;
      if (savedId === undefined) {
        savedId = await create({ description, title });
      } else {
        await updateDetails({ appId: savedId, description, title });
      }
      onOpenChange(false);
      if (onSaved !== undefined) {
        await onSaved(savedId);
      }
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't save the app."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{appId === undefined ? "New app" : "App details"}</DialogTitle>
          <DialogDescription>
            An app is a page of maps, charts, tables and notes built from your datasets — laid out
            your way and shareable by link.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="app-title"
              value={title}
              maxLength={APP_LIMITS.title}
              placeholder="Safe Streets awards explorer"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
            {titleMissing && <p className="text-xs text-muted-foreground">A title is required.</p>}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-description">Description</Label>
            <Textarea
              id="app-description"
              value={description}
              maxLength={APP_LIMITS.description}
              rows={3}
              placeholder="Optional — shown under the title for viewers"
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || titleMissing}>
              {submitting ? "Saving…" : appId === undefined ? "Create app" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
