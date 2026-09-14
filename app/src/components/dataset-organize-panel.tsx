import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { Select } from "#/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { api } from "#convex/_generated/api";

const NONE = "";

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Side panel for assigning a dataset to a collection and, optionally, a group within it. */
export function DatasetOrganizePanel({
  schemaId,
  currentCollectionId,
  currentGroupId,
  open,
  onOpenChange,
}: {
  schemaId: string;
  currentCollectionId: string | undefined;
  currentGroupId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const collections = useQuery(api.collections.list),
    [collectionId, setCollectionId] = useState(currentCollectionId ?? NONE),
    [groupId, setGroupId] = useState(currentGroupId ?? NONE),
    groups = useQuery(api.groups.list, collectionId === NONE ? "skip" : { collectionId }),
    setSchemaCollection = useMutation(api.collections.setSchemaCollection),
    setSchemaGroup = useMutation(api.collections.setSchemaGroup),
    [isSubmitting, setIsSubmitting] = useState(false),
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      setIsSubmitting(true);
      try {
        if (collectionId === NONE) {
          await setSchemaCollection({ collectionId: null, schemaId });
        } else if (groupId !== NONE) {
          await setSchemaGroup({ groupId, schemaId });
        } else {
          await setSchemaCollection({ collectionId, schemaId });
        }
        toast.success("Dataset organization updated.");
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to update dataset organization."));
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setCollectionId(currentCollectionId ?? NONE);
          setGroupId(currentGroupId ?? NONE);
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Organize dataset</SheetTitle>
          <SheetDescription>
            Assign this dataset to a collection and, optionally, a group.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="dataset-collection">Collection</Label>
            <Select
              id="dataset-collection"
              value={collectionId}
              onChange={(e) => {
                setCollectionId(e.target.value);
                setGroupId(NONE);
              }}
            >
              <option value={NONE}>No collection</option>
              {(collections ?? []).map((collection) => (
                <option key={collection._id} value={collection._id}>
                  {collection.name}
                </option>
              ))}
            </Select>
          </div>

          {collectionId !== NONE && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="dataset-group">Group (optional)</Label>
              <Select
                id="dataset-group"
                value={groupId}
                onChange={(e) => {
                  setGroupId(e.target.value);
                }}
              >
                <option value={NONE}>Ungrouped</option>
                {(groups ?? []).map((group) => (
                  <option key={group._id} value={group._id}>
                    {group.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <SheetFooter className="mt-2 flex-row justify-end p-0">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
