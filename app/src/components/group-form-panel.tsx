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

type Group = { _id: string; name: string; description?: string };

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Side panel for creating or editing a group (a sub-collection). Groups may live inside a collection (`collectionId`) or float standalone. */
export function GroupFormPanel({
  collectionId,
  group,
  open,
  onOpenChange,
}: {
  collectionId?: string;
  group?: Group;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEditing = group !== undefined,
    createGroup = useMutation(api.groups.create),
    updateGroup = useMutation(api.groups.update),
    [name, setName] = useState(isEditing ? group.name : ""),
    [description, setDescription] = useState(isEditing ? (group.description ?? "") : ""),
    [isSubmitting, setIsSubmitting] = useState(false),
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      if (!name.trim()) {
        toast.error("Give the group a name.");
        return;
      }

      setIsSubmitting(true);
      try {
        if (isEditing) {
          await updateGroup({
            description: description.trim() || undefined,
            groupId: group._id,
            name: name.trim(),
          });
          toast.success("Group updated.");
        } else {
          await createGroup({
            collectionId,
            description: description.trim() || undefined,
            name: name.trim(),
          });
          toast.success("Group created.");
          setName("");
          setDescription("");
        }
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, `Failed to ${isEditing ? "update" : "create"} group.`));
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(isEditing ? group.name : "");
          setDescription(isEditing ? (group.description ?? "") : "");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{isEditing ? "Edit group" : "Create group"}</SheetTitle>
          <SheetDescription>
            A group is a tighter-coupled set of datasets inside this collection — e.g. this year's
            polygons and points datasets.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="SMART Grant 2025"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-description">Description (optional)</Label>
            <Textarea
              id="group-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="What this group is for"
              rows={3}
            />
          </div>
          <SheetFooter className="mt-2 flex-row justify-end p-0">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create group"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
