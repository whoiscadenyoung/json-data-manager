import { Button } from "@caden/ui/components/button";
import { Input } from "@caden/ui/components/input";
import { Label } from "@caden/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@caden/ui/components/select";
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
import type { CollectionRow } from "#/lib/store/collections";
import * as groupsStore from "#/lib/store/groups";
import type { GroupRow } from "#/lib/store/groups";

const NO_PARENT = "none";

/**
 * Side panel for creating or editing a Postgres group — the Convex
 * `GroupFormPanel`'s PG edition. Create mode offers the parent-collection
 * select (a group may float standalone, component parity); edit mode manages
 * name/description only — moving between collections is the collection
 * add-sheet's "add as one unit" action (`groups.setCollection`), exactly as
 * on Convex.
 */
export function PgGroupFormPanel({
  collectionId,
  collections,
  group,
  open,
  onOpenChange,
}: {
  /** Preselects the parent collection (the collection page's "New group"). */
  collectionId?: string;
  /** Every collection, for the parent select (create mode). */
  collections: CollectionRow[];
  /** Present in edit mode; absent to create. */
  group?: GroupRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient(),
    isEditing = group !== undefined,
    [name, setName] = useState(isEditing ? group.name : ""),
    [description, setDescription] = useState(isEditing ? (group.description ?? "") : ""),
    [parentId, setParentId] = useState(collectionId ?? NO_PARENT),
    [isSubmitting, setIsSubmitting] = useState(false),
    invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["pg:groups"] });
      void queryClient.invalidateQueries({ queryKey: ["pg:collections"] });
    },
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      if (!name.trim()) {
        toast.error("Give the group a name.");
        return;
      }
      setIsSubmitting(true);
      try {
        if (isEditing) {
          await groupsStore.update({
            description: description.trim(),
            groupId: group.id,
            name: name.trim(),
          });
          toast.success("Group updated.");
        } else {
          await groupsStore.create({
            collectionId: parentId === NO_PARENT ? undefined : parentId,
            description: description.trim(),
            name: name.trim(),
          });
          toast.success("Group created.");
          setName("");
          setDescription("");
          setParentId(NO_PARENT);
        }
        invalidate();
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
          setParentId(collectionId ?? NO_PARENT);
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{isEditing ? "Edit group" : "Create group"}</SheetTitle>
          <SheetDescription>
            A group bundles related datasets, which then appear under the group in the datasets
            browser.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="pg-group-name">Name</Label>
            <Input
              id="pg-group-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="FY24 grants"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pg-group-description">Description (optional)</Label>
            <Textarea
              id="pg-group-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="What this group is for"
              rows={3}
            />
          </div>
          {!isEditing && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="pg-group-parent">Parent collection (optional)</Label>
              <Select
                value={parentId}
                onValueChange={(value) => {
                  setParentId(value ?? NO_PARENT);
                }}
              >
                <SelectTrigger className="w-full" id="pg-group-parent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT}>Standalone (no collection)</SelectItem>
                  {collections.map((collection) => (
                    <SelectItem key={collection.id} value={collection.id}>
                      {collection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
