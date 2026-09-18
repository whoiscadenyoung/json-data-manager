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

type Location = Doc<"locations">;

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "data" in error) {
    const { data } = error;
    if (typeof data === "string") {
      return data;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/** Locations tab — CRUD over the `locations` table (the lat/lng rows the projection turns into Points). */
export function LocationsPanel() {
  const locations = useQuery(api.dashboard.listLocations),
    links = useQuery(api.dashboard.listLinks),
    createLocation = useMutation(api.dashboard.createLocation),
    updateLocation = useMutation(api.dashboard.updateLocation),
    deleteLocation = useMutation(api.dashboard.deleteLocation),
    [sheetOpen, setSheetOpen] = useState(false),
    [editing, setEditing] = useState<Location | undefined>(undefined),
    [label, setLabel] = useState(""),
    [address, setAddress] = useState(""),
    [city, setCity] = useState(""),
    [state, setState] = useState(""),
    [latInput, setLatInput] = useState(""),
    [lngInput, setLngInput] = useState(""),
    [isSubmitting, setIsSubmitting] = useState(false),
    [deleting, setDeleting] = useState<Location | undefined>(undefined),
    [isDeleting, setIsDeleting] = useState(false),
    openCreate = () => {
      setEditing(undefined);
      setLabel("");
      setAddress("");
      setCity("");
      setState("");
      setLatInput("");
      setLngInput("");
      setSheetOpen(true);
    },
    openEdit = (location: Location) => {
      setEditing(location);
      setLabel(location.label);
      setAddress(location.address);
      setCity(location.city);
      setState(location.state);
      setLatInput(String(location.lat));
      setLngInput(String(location.lng));
      setSheetOpen(true);
    },
    handleSubmit = async (event: React.FormEvent) => {
      event.preventDefault();
      const lat = Number.parseFloat(latInput),
        lng = Number.parseFloat(lngInput);
      if (Number.isNaN(lat) || Number.isNaN(lng)) {
        toast.error("Latitude and longitude must be numbers.");
        return;
      }
      setIsSubmitting(true);
      try {
        if (editing === undefined) {
          await createLocation({ address, city, label, lat, lng, state });
          toast.success("Location created.");
        } else {
          await updateLocation({ address, city, id: editing._id, label, lat, lng, state });
          toast.success("Location updated.");
        }
        setSheetOpen(false);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to save the location."));
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
        const cascaded = await deleteLocation({ id: deleting._id });
        toast.success(
          `Deleted ${deleting.label}${cascaded > 0 ? ` and ${cascaded} link(s)` : ""}.`,
        );
        setDeleting(undefined);
      } catch (error) {
        toast.error(errorMessage(error, "Failed to delete the location."));
      } finally {
        setIsDeleting(false);
      }
    };

  if (locations === undefined || links === undefined) {
    return <p className="text-sm text-muted-foreground">Loading locations…</p>;
  }

  const linkCounts = new Map<string, number>();
  for (const link of links) {
    linkCounts.set(link.locationId, (linkCounts.get(link.locationId) ?? 0) + 1);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          onClick={() => {
            openCreate();
          }}
        >
          New location
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>City</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Lat, Lng</TableHead>
              <TableHead className="w-24 text-right">Links</TableHead>
              <TableHead className="w-36 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.length === 0 ? (
              <TableRow>
                <TableCell className="text-sm text-muted-foreground" colSpan={7}>
                  No locations yet — add one with a latitude/longitude to place it on the map.
                </TableCell>
              </TableRow>
            ) : (
              locations.map((location) => (
                <TableRow key={location._id}>
                  <TableCell className="font-medium">{location.label}</TableCell>
                  <TableCell className="max-w-48 truncate">{location.address}</TableCell>
                  <TableCell>{location.city}</TableCell>
                  <TableCell>{location.state}</TableCell>
                  <TableCell className="tabular-nums">
                    {location.lat}, {location.lng}
                  </TableCell>
                  <TableCell className="text-right">{linkCounts.get(location._id) ?? 0}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          openEdit(location);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setDeleting(location);
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
            <SheetTitle>{editing === undefined ? "New location" : "Edit location"}</SheetTitle>
            <SheetDescription>
              The latitude/longitude pair becomes the projected dataset's Point geometry ([lng, lat]
              per GeoJSON).
            </SheetDescription>
          </SheetHeader>
          <form
            onSubmit={(event) => {
              void handleSubmit(event);
            }}
            className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="location-label">Label</Label>
              <Input
                id="location-label"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                }}
                placeholder="Red Lobster — Norfolk"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="location-address">Address</Label>
              <Input
                id="location-address"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                }}
                placeholder="5800 E Virginia Beach Blvd"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="location-city">City</Label>
                <Input
                  id="location-city"
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value);
                  }}
                  placeholder="Norfolk"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="location-state">State</Label>
                <Input
                  id="location-state"
                  value={state}
                  onChange={(e) => {
                    setState(e.target.value);
                  }}
                  placeholder="VA"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="location-lat">Latitude</Label>
                <Input
                  id="location-lat"
                  inputMode="decimal"
                  value={latInput}
                  onChange={(e) => {
                    setLatInput(e.target.value);
                  }}
                  placeholder="36.8508"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="location-lng">Longitude</Label>
                <Input
                  id="location-lng"
                  inputMode="decimal"
                  value={lngInput}
                  onChange={(e) => {
                    setLngInput(e.target.value);
                  }}
                  placeholder="-76.2859"
                />
              </div>
            </div>
            <SheetFooter className="mt-2 flex-row justify-end p-0">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? "Saving…"
                  : editing === undefined
                    ? "Create location"
                    : "Save changes"}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <ConfirmDeleteDialog
        description="This also deletes links pointing at the location. The projected dataset keeps its current features until the next sync."
        entityLabel="location"
        isPending={isDeleting}
        name={deleting === undefined ? undefined : deleting.label}
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
