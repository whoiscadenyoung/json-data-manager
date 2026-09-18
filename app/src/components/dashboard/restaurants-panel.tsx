import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDeleteDialog } from "#/components/dashboard/confirm-delete-dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { api } from "#convex/_generated/api";
import type { Doc } from "#convex/_generated/dataModel";

type Restaurant = Doc<"restaurants">;

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Restaurants tab — CRUD over the `restaurants` table. Deleting cascades to the restaurant's links. */
export function RestaurantsPanel() {
  const restaurants = useQuery(api.dashboard.listRestaurants),
    links = useQuery(api.dashboard.listLinks),
    createRestaurant = useMutation(api.dashboard.createRestaurant),
    updateRestaurant = useMutation(api.dashboard.updateRestaurant),
    deleteRestaurant = useMutation(api.dashboard.deleteRestaurant),
    [sheetOpen, setSheetOpen] = useState(false),
    [editing, setEditing] = useState<Restaurant | undefined>(undefined),
    [name, setName] = useState(""),
    [cuisine, setCuisine] = useState(""),
    [isSubmitting, setIsSubmitting] = useState(false),
    [deleting, setDeleting] = useState<Restaurant | undefined>(undefined),
    [isDeleting, setIsDeleting] = useState(false),
    openCreate = () => {
      setEditing(undefined);
      setName("");
      setCuisine("");
      setSheetOpen(true);
    },
    openEdit = (restaurant: Restaurant) => {
      setEditing(restaurant);
      setName(restaurant.name);
      setCuisine(restaurant.cuisine);
      setSheetOpen(true);
    },
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      setIsSubmitting(true);
      try {
        if (editing === undefined) {
          await createRestaurant({ cuisine, name });
          toast.success("Restaurant created.");
        } else {
          await updateRestaurant({ cuisine, id: editing._id, name });
          toast.success("Restaurant updated.");
        }
        setSheetOpen(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to save the restaurant."));
      } finally {
        setIsSubmitting(false);
      }
    },
    handleDelete = async () => {
      if (deleting === undefined) {
        return;
      }
      setIsDeleting(true);
      try {
        const cascaded = await deleteRestaurant({ id: deleting._id });
        toast.success(`Deleted ${deleting.name}${cascaded > 0 ? ` and ${cascaded} link(s)` : ""}.`);
        setDeleting(undefined);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete the restaurant."));
      } finally {
        setIsDeleting(false);
      }
    };

  if (restaurants === undefined || links === undefined) {
    return <p className="text-sm text-muted-foreground">Loading restaurants…</p>;
  }

  const linkCounts = new Map<string, number>();
  for (const link of links) {
    linkCounts.set(link.restaurantId, (linkCounts.get(link.restaurantId) ?? 0) + 1);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            openCreate();
          }}
        >
          New restaurant
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Cuisine</TableHead>
              <TableHead className="w-24 text-right">Locations</TableHead>
              <TableHead className="w-36 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {restaurants.length === 0 ? (
              <TableRow>
                <TableCell className="text-sm text-muted-foreground" colSpan={4}>
                  No restaurants yet — create one, then link locations to it.
                </TableCell>
              </TableRow>
            ) : (
              restaurants.map((restaurant) => (
                <TableRow key={restaurant._id}>
                  <TableCell className="font-medium">{restaurant.name}</TableCell>
                  <TableCell>{restaurant.cuisine}</TableCell>
                  <TableCell className="text-right">
                    {linkCounts.get(restaurant._id) ?? 0}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          openEdit(restaurant);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setDeleting(restaurant);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{editing === undefined ? "New restaurant" : "Edit restaurant"}</SheetTitle>
            <SheetDescription>
              A restaurant groups the locations linked to it in the projection.
            </SheetDescription>
          </SheetHeader>
          <form
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
            className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="restaurant-name">Name</Label>
              <Input
                id="restaurant-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                placeholder="Red Lobster"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="restaurant-cuisine">Cuisine</Label>
              <Input
                id="restaurant-cuisine"
                value={cuisine}
                onChange={(e) => {
                  setCuisine(e.target.value);
                }}
                placeholder="Seafood"
              />
            </div>
            <SheetFooter className="mt-2 flex-row justify-end p-0">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? "Saving…"
                  : editing === undefined
                    ? "Create restaurant"
                    : "Save changes"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <ConfirmDeleteDialog
        description="This also deletes the restaurant's location links. The projected dataset keeps its current features until the next sync."
        entityLabel="restaurant"
        isPending={isDeleting}
        name={deleting === undefined ? undefined : deleting.name}
        onCancel={() => {
          setDeleting(undefined);
        }}
        onConfirm={() => {
          void handleDelete();
        }}
      />
    </div>
  );
}
