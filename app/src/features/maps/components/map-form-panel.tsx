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
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";

type MapDoc = { _id: string; name: string; description?: string };

/** The name/description submit, injected per backend (Convex by default; the maps store for Postgres maps). */
export type MapFormSubmit = (args: { description?: string; name: string }) => Promise<void>;

/** Side panel for creating or editing a map (name + description). */
export function MapFormPanel({
  map,
  open,
  onOpenChange,
  onSubmit,
}: {
  map?: MapDoc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every live caller passes the store-backed submit; the pre-migration
   * Convex flow that omitted it is archived with the stage-7 disconnect
   * (issue #206) — omitting it now fails loudly instead of mutating Convex. */
  onSubmit?: MapFormSubmit;
}) {
  const isEditing = map !== undefined,
    [name, setName] = useState(isEditing ? map.name : ""),
    [description, setDescription] = useState(isEditing ? (map.description ?? "") : ""),
    [isSubmitting, setIsSubmitting] = useState(false),
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      if (!name.trim()) {
        toast.error("Give the map a name.");
        return;
      }

      setIsSubmitting(true);
      try {
        if (onSubmit !== undefined) {
          await onSubmit({ description: description.trim() || undefined, name: name.trim() });
          if (isEditing) {
            toast.success("Map updated.");
          } else {
            toast.success("Map created.");
            setName("");
            setDescription("");
          }
        } else {
          throw new Error(
            "Convex maps are archived in this build (stage 7 disconnect): maps write through the Postgres store.",
          );
        }
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, `Failed to ${isEditing ? "update" : "create"} map.`));
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(isEditing ? map.name : "");
          setDescription(isEditing ? (map.description ?? "") : "");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{isEditing ? "Edit map" : "Create map"}</SheetTitle>
          <SheetDescription>
            A map is a custom arrangement of collections, groups, and datasets rendered together.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="map-name">Name</Label>
            <Input
              id="map-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="Corridor study"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="map-description">Description (optional)</Label>
            <Textarea
              id="map-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="What this map shows"
              rows={3}
            />
          </div>
          <SheetFooter className="mt-2 flex-row justify-end p-0">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Create map"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
