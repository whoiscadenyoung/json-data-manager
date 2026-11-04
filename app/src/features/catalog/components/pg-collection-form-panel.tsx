import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@caden/ui/components/sheet";
import { Textarea } from "@caden/ui/components/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as collectionsStore from "#/lib/store/collections";
import type { CollectionRow } from "#/lib/store/collections";

/**
 * Side panel for creating or editing a Postgres collection (name +
 * description) — the Convex `CollectionFormPanel`'s PG edition. New
 * collections are Postgres-native (the §14 transitional split: they organize
 * the PG datasets a PG collection can hold; a Convex collection can never
 * contain one).
 */
export function PgCollectionFormPanel({
  collection,
  open,
  onOpenChange,
}: {
  /** Present in edit mode; absent to create. */
  collection?: CollectionRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient(),
    isEditing = collection !== undefined,
    [name, setName] = useState(isEditing ? collection.name : ""),
    [description, setDescription] = useState(isEditing ? (collection.description ?? "") : ""),
    [isSubmitting, setIsSubmitting] = useState(false),
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      // Name is the only required field (ui-polish: description optional) —
      // the empty submit explains itself instead of silently doing nothing
      // (the store's own "Collection must have a name" assert is layer 2).
      if (!name.trim()) {
        toast.error("Give the collection a name.");
        return;
      }
      setIsSubmitting(true);
      try {
        if (isEditing) {
          await collectionsStore.update({
            collectionId: collection.id,
            description: description.trim(),
            name: name.trim(),
          });
          toast.success("Collection updated.");
        } else {
          await collectionsStore.create({ description: description.trim(), name: name.trim() });
          toast.success("Collection created.");
          setName("");
          setDescription("");
        }
        void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
        onOpenChange(false);
      } catch (error) {
        toast.error(
          errorMessage(error, `Failed to ${isEditing ? "update" : "create"} collection.`),
        );
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(isEditing ? collection.name : "");
          setDescription(isEditing ? (collection.description ?? "") : "");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{isEditing ? "Edit collection" : "Create collection"}</SheetTitle>
          <SheetDescription>
            A collection groups related datasets together — e.g. every dataset for a grant program.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="pg-collection-name">Name</Label>
            <Input
              id="pg-collection-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="Grant data"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pg-collection-description">Description (optional)</Label>
            <Textarea
              id="pg-collection-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="What this collection is for"
              rows={3}
            />
          </div>
          <SheetFooter className="mt-2 flex-row justify-end p-0">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create collection"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
