import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
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

type LinkRow = Doc<"restaurantLocations"> & {
  city: string;
  label: string;
  restaurantName: string;
};

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

type SelectItemOption = { label: string; value: string };

/** One labeled entity select; "" (null to base-ui) means no selection yet. */
function EntitySelect({
  items,
  label,
  onChange,
  placeholder,
  value,
  selectId,
}: {
  items: Array<SelectItemOption>;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  selectId: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={selectId}>{label}</Label>
      <Select
        items={items}
        value={value === "" ? null : value}
        onValueChange={(next) => {
          onChange(next ?? "");
        }}
      >
        <SelectTrigger id={selectId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Links tab — CRUD over the `restaurantLocations` join (which restaurants
 * operate which locations; Red Lobster → 3 locations in the seed). The
 * (restaurant, location) pair is immutable after creation — edit only the
 * opened year — matching the compound index that enforces pair uniqueness.
 */
export function LinksPanel() {
  const links = useQuery(api.dashboard.listLinks),
    restaurants = useQuery(api.dashboard.listRestaurants),
    locations = useQuery(api.dashboard.listLocations),
    createLink = useMutation(api.dashboard.createLink),
    updateLink = useMutation(api.dashboard.updateLink),
    deleteLink = useMutation(api.dashboard.deleteLink),
    [sheetOpen, setSheetOpen] = useState(false),
    // `editing` undefined = create mode; set = only the opened year is editable.
    [editing, setEditing] = useState<LinkRow | undefined>(undefined),
    [restaurantId, setRestaurantId] = useState(""),
    [locationId, setLocationId] = useState(""),
    [openedYearInput, setOpenedYearInput] = useState(""),
    [isSubmitting, setIsSubmitting] = useState(false),
    openCreate = () => {
      setEditing(undefined);
      setRestaurantId("");
      setLocationId("");
      setOpenedYearInput("");
      setSheetOpen(true);
    },
    openEdit = (link: LinkRow) => {
      setEditing(link);
      setOpenedYearInput(link.openedYear === undefined ? "" : String(link.openedYear));
      setSheetOpen(true);
    },
    parseOpenedYear = (): number | null | undefined => {
      const trimmed = openedYearInput.trim();
      if (trimmed === "") {
        return editing === undefined ? undefined : null;
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isNaN(parsed)) {
        toast.error("Opened year must be a number (or blank).");
        return undefined;
      }
      return parsed;
    },
    /** Creates the pair from the current selects; false means validation failed. */
    submitCreate = async (openedYear: number | null | undefined): Promise<boolean> => {
      if (restaurants === undefined || locations === undefined) {
        return false;
      }
      const restaurant = restaurants.find((r) => r._id === restaurantId),
        location = locations.find((l) => l._id === locationId);
      if (restaurant === undefined || location === undefined) {
        toast.error("Pick both a restaurant and a location.");
        return false;
      }
      await createLink({
        locationId: location._id,
        openedYear: typeof openedYear === "number" ? openedYear : undefined,
        restaurantId: restaurant._id,
      });
      toast.success("Link created.");
      return true;
    },
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      const openedYear = parseOpenedYear();
      if (openedYear === undefined && openedYearInput.trim() !== "") {
        return;
      }
      setIsSubmitting(true);
      try {
        if (editing === undefined) {
          const created = await submitCreate(openedYear);
          if (!created) {
            return;
          }
        } else {
          await updateLink({ id: editing._id, openedYear: openedYear ?? null });
          toast.success("Link updated.");
        }
        setSheetOpen(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to save the link."));
      } finally {
        setIsSubmitting(false);
      }
    },
    handleDelete = async (link: LinkRow) => {
      try {
        await deleteLink({ id: link._id });
        toast.success(`Deleted ${link.restaurantName} → ${link.label}.`);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete the link."));
      }
    };

  if (links === undefined || restaurants === undefined || locations === undefined) {
    return <p className="text-sm text-muted-foreground">Loading links…</p>;
  }

  // base-ui's Select renders the raw value unless the root knows the items —
  // passing the {value, label} maps makes SelectValue show names and powers
  // keyboard typeahead in the popup.
  const restaurantItems = restaurants.map((r) => ({ label: r.name, value: r._id })),
    locationItems = locations.map((l) => ({ label: l.label, value: l._id }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            openCreate();
          }}
        >
          New link
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Restaurant</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>City</TableHead>
              <TableHead className="w-24">Opened</TableHead>
              <TableHead className="w-36 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.length === 0 ? (
              <TableRow>
                <TableCell className="text-sm text-muted-foreground" colSpan={5}>
                  No links yet — each link becomes one point in the projected dataset.
                </TableCell>
              </TableRow>
            ) : (
              links.map((link) => (
                <TableRow key={link._id}>
                  <TableCell className="font-medium">{link.restaurantName}</TableCell>
                  <TableCell>{link.label}</TableCell>
                  <TableCell>{link.city}</TableCell>
                  <TableCell>{link.openedYear ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          openEdit(link);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          void handleDelete(link);
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
            <SheetTitle>{editing === undefined ? "New link" : "Edit link"}</SheetTitle>
            <SheetDescription>
              {editing === undefined
                ? "Link a restaurant to a location it operates — one link becomes one map point."
                : `Editing ${editing.restaurantName} → ${editing.label}. The pair itself is immutable.`}
            </SheetDescription>
          </SheetHeader>
          <form
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
            className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
          >
            {editing === undefined ? (
              <>
                <EntitySelect
                  items={restaurantItems}
                  label="Restaurant"
                  onChange={setRestaurantId}
                  placeholder="Pick a restaurant"
                  selectId="link-restaurant"
                  value={restaurantId}
                />
                <EntitySelect
                  items={locationItems}
                  label="Location"
                  onChange={setLocationId}
                  placeholder="Pick a location"
                  selectId="link-location"
                  value={locationId}
                />
              </>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="link-opened-year">Opened year (optional)</Label>
              <Input
                id="link-opened-year"
                inputMode="numeric"
                value={openedYearInput}
                onChange={(e) => {
                  setOpenedYearInput(e.target.value);
                }}
                placeholder="2011"
              />
            </div>
            <SheetFooter className="mt-2 flex-row justify-end p-0">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : editing === undefined ? "Create link" : "Save changes"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
