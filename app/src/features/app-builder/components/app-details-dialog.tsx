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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Spinner } from "#/components/ui/spinner";
import { Textarea } from "#/components/ui/textarea";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import { APP_LIMITS } from "#convex/appBuilder/validators";

/** The required title — invalid (and saying so) while empty. */
function TitleField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const missing = value.trim() === "";
  return (
    <Field data-invalid={missing ? true : undefined}>
      <FieldLabel htmlFor="app-title">
        Title <span className="text-destructive">*</span>
      </FieldLabel>
      <Input
        id="app-title"
        value={value}
        maxLength={APP_LIMITS.title}
        placeholder="Safe Streets awards explorer"
        aria-invalid={missing ? true : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {missing && <FieldDescription>A title is required.</FieldDescription>}
    </Field>
  );
}

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
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <TitleField value={title} onChange={setTitle} />
            <Field>
              <FieldLabel htmlFor="app-description">Description</FieldLabel>
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
            </Field>
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
                {submitting && <Spinner data-icon="inline-start" />}
                {appId === undefined ? "Create app" : "Save"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
