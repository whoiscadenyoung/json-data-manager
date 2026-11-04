import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@caden/ui/components/field";
import { Input } from "@caden/ui/components/input";
import { Spinner } from "@caden/ui/components/spinner";
import { Textarea } from "@caden/ui/components/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as appsStore from "#/lib/store/apps";

import { APP_LIMITS } from "../lib/content";

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
 * The title is the only required field (the app-wide rule). A denied
 * metadata write answers 0 rows affected (RLS — the silent-denial rule), and
 * that is surfaced as the error it is: the dialog stays open, nothing is
 * saved.
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
  const queryClient = useQueryClient(),
    create = useMutation({
      mutationFn: async (args: { description: string; title: string }) =>
        await appsStore.create(args),
    }),
    updateDetails = useMutation({
      mutationFn: async (args: { appId: string; description: string; title: string }) =>
        await appsStore.updateDetails(args),
    }),
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
        // `create` answers the full new row (the insert's RETURNING).
        savedId = (await create.mutateAsync({ description, title })).id;
      } else {
        const affected = await updateDetails.mutateAsync({ appId: savedId, description, title });
        if (affected === 0) {
          // RLS answered with 0 rows — this viewer cannot edit the app.
          toast.error("Couldn't save — only the app's creator can edit it.");
          return;
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
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
