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
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";

/**
 * Side panel for editing a project map's own fields — name and description
 * (the camera has its own explicit "Save view" write in the editor). The
 * name is the only required field: the submit button stays live and the
 * blank-name refusal is the server's, surfaced in the toast (the UI rule —
 * never a silently disabled Save).
 */
export function MapFormPanel({
  map,
  open,
  onOpenChange,
}: {
  map: { _id: string; description?: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateMap = useMutation(api.projectMaps.update),
    [name, setName] = useState(map.name),
    [description, setDescription] = useState(map.description ?? ""),
    [isSubmitting, setIsSubmitting] = useState(false),
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      setIsSubmitting(true);
      try {
        await updateMap({
          description: description.trim() === "" ? undefined : description.trim(),
          mapId: map._id,
          name: name.trim(),
        });
        toast.success("Map updated.");
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to update the map."));
      } finally {
        setIsSubmitting(false);
      }
    };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(map.name);
          setDescription(map.description ?? "");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Edit map</SheetTitle>
          <SheetDescription>
            A map is this project's canvas — its layers draw in list order.
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
              {isSubmitting ? "Saving…" : "Save changes"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
