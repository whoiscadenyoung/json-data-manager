import { Button } from "@caden/ui/components/button";
import { Checkbox } from "@caden/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { savedDefinitionQueryOptions } from "#/lib/store/view-reads";

import { outputOfDefinition, popupFieldsFromView, popupOverrideOf } from "../lib/popup-fields";

/**
 * Per-layer popup fields (issue #303). A layer over a view follows the view's
 * labels and order ("from view") until it gets its own list; "Reset to from
 * view" clears the override (`popup = null`).
 */
export function PopupFieldsDialog({
  datasetId,
  onOpenChange,
  onSave,
  open,
  popup,
}: {
  datasetId: string;
  onOpenChange: (open: boolean) => void;
  /** `null` resets to "from view". */
  onSave: (popup: { fields: { key: string; label: string }[] } | null) => Promise<void>;
  open: boolean;
  popup: unknown;
}) {
  const definition = useQuery({ ...savedDefinitionQueryOptions(datasetId), enabled: open }),
    output = outputOfDefinition(definition.data),
    available = popupFieldsFromView(output) ?? [],
    override = popupOverrideOf(popup),
    [picked, setPicked] = useState<string[] | undefined>(),
    chosen =
      picked ?? (override === undefined ? available.map((f) => f.key) : override.map((f) => f.key)),
    [saving, setSaving] = useState(false),
    run = async (next: { fields: { key: string; label: string }[] } | null): Promise<void> => {
      setSaving(true);
      try {
        await onSave(next);
        setPicked(undefined);
        onOpenChange(false);
      } finally {
        setSaving(false);
      }
    };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Popup fields</DialogTitle>
          <DialogDescription>
            {override === undefined
              ? "From view: this layer shows the view's labels and order."
              : "This layer has its own popup fields."}
          </DialogDescription>
        </DialogHeader>
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This layer isn&apos;t over a view with output labels, so its popup shows every property.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {available.map((field) => (
              <li className="flex items-center gap-2 text-sm" key={field.key}>
                <Checkbox
                  aria-label={`Show ${field.label}`}
                  checked={chosen.includes(field.key)}
                  onCheckedChange={(checked) => {
                    setPicked(
                      available
                        .map((item) => item.key)
                        .filter((key) => (key === field.key ? checked : chosen.includes(key))),
                    );
                  }}
                />
                <span>{field.label}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            disabled={saving || override === undefined}
            onClick={() => {
              void run(null);
            }}
            variant="outline"
          >
            Reset to from view
          </Button>
          <Button
            disabled={saving || available.length === 0}
            onClick={() => {
              void run({ fields: available.filter((f) => chosen.includes(f.key)) });
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
