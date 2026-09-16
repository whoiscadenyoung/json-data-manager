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

type MapDoc = { _id: string; name: string; description?: string };

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Side panel for creating or editing a map (name + description). */
export function MapFormPanel({
  map,
  open,
  onOpenChange,
}: {
  map?: MapDoc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEditing = map !== undefined,
    createMap = useMutation(api.maps.create),
    updateMap = useMutation(api.maps.update),
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
        if (isEditing) {
          await updateMap({
            description: description.trim() || undefined,
            mapId: map._id,
            name: name.trim(),
          });
          toast.success("Map updated.");
        } else {
          await createMap({
            description: description.trim() || undefined,
            name: name.trim(),
          });
          toast.success("Map created.");
          setName("");
          setDescription("");
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
