import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#convex/_generated/api";

type Collection = { _id: string; name: string; description?: string };

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Side panel for creating or editing a collection (name + description). */
export function CollectionFormPanel({
  collection,
  open,
  onOpenChange,
}: {
  collection?: Collection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEditing = collection !== undefined,
    createCollection = useMutation(api.collections.create),
    updateCollection = useMutation(api.collections.update),
    [name, setName] = useState(isEditing ? collection.name : ""),
    [description, setDescription] = useState(isEditing ? (collection.description ?? "") : ""),
    [isSubmitting, setIsSubmitting] = useState(false),
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      if (!name.trim()) {
        toast.error("Give the collection a name.");
        return;
      }

      setIsSubmitting(true);
      try {
        if (isEditing) {
          await updateCollection({
            collectionId: collection._id,
            description: description.trim() || undefined,
            name: name.trim(),
          });
          toast.success("Collection updated.");
        } else {
          await createCollection({
            description: description.trim() || undefined,
            name: name.trim(),
          });
          toast.success("Collection created.");
          setName("");
          setDescription("");
        }
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
            <Label htmlFor="collection-name">Name</Label>
            <Input
              id="collection-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="Grant data"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="collection-description">Description (optional)</Label>
            <Textarea
              id="collection-description"
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
