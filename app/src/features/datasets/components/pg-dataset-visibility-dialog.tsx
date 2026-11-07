import { Badge } from "@caden/ui/components/badge";
import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@caden/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@caden/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@caden/ui/components/radio-group";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Link2, Lock, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as datasetsStore from "#/lib/store/datasets";
import type { VisibilityLevel } from "#/lib/store/visibility";

/**
 * The dataset's share dialog (issue #260, ADR 0022): the unified visibility
 * ladder on the leaf artifact. A dataset references nothing, so its share
 * needs no closure walk — every rung lands through the plain RLS'd
 * `setVisibility` write, and the dialog says what each rung means. The
 * composite artifacts (apps, maps, the project press) widen through the
 * closure preflight instead.
 */

const OPTIONS: ReadonlyArray<{
  value: VisibilityLevel;
  label: string;
  description: string;
  icon: typeof Lock;
}> = [
  {
    description: "You and the members of projects that hold this dataset.",
    icon: Lock,
    label: "Project members",
    value: "members",
  },
  {
    description: "Every signed-in member of this workspace can see it in the catalog.",
    icon: Users,
    label: "Anyone signed in",
    value: "signed-in",
  },
  {
    description:
      "Visitors holding a link to its published data can read it without signing in — recorded and enforced on the frozen data now; anonymous serving itself ships with public serving.",
    icon: Link2,
    label: "Anyone with the link",
    value: "link",
  },
  {
    description: "Like the link level, and discoverable in the explorers.",
    icon: Globe,
    label: "Public",
    value: "public",
  },
];

export function PgDatasetVisibilityDialog({
  dataset,
  open,
  onOpenChange,
}: {
  dataset: datasetsStore.DatasetRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient(),
    [pending, setPending] = useState<VisibilityLevel | undefined>(),
    setVisibility = async (next: VisibilityLevel) => {
      if (next === dataset.visibility) {
        return;
      }
      setPending(next);
      try {
        const affected = await datasetsStore.setVisibility({
          datasetId: dataset.id,
          visibility: next,
        });
        if (affected === 0) {
          // RLS answered 0 rows — this viewer cannot edit the dataset; the
          // radio stays honest instead of pretending the flip landed.
          toast.error("Couldn't change visibility — you may not be able to edit this dataset.");
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
        toast.success(
          next === "members"
            ? "Only you and the holding projects' members can see this dataset now."
            : `This dataset is now visible at “${next}”.`,
        );
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't update who can see this dataset."));
      } finally {
        setPending(undefined);
      }
    };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share dataset</DialogTitle>
          <DialogDescription>
            Choose who can see this dataset. Its rows feed every layer and app that references it —
            a narrower rung hides it from those viewers too.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend className="sr-only">Who can see this dataset</FieldLegend>
            <RadioGroup
              value={pending ?? dataset.visibility}
              disabled={pending !== undefined}
              onValueChange={(value) => {
                const next = OPTIONS.find((option) => option.value === value);
                if (next !== undefined) {
                  void setVisibility(next.value);
                }
              }}
            >
              {OPTIONS.map((option) => {
                const Icon = option.icon,
                  id = `dataset-visibility-${option.value}`,
                  current = option.value === dataset.visibility;
                return (
                  <FieldLabel key={option.value} htmlFor={id}>
                    <Field orientation="horizontal">
                      <Icon />
                      <FieldContent>
                        <FieldTitle>
                          {option.label}
                          {current && (
                            <Badge className="ml-2" variant="secondary">
                              current
                            </Badge>
                          )}
                        </FieldTitle>
                        <FieldDescription>{option.description}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem id={id} value={option.value} />
                    </Field>
                  </FieldLabel>
                );
              })}
            </RadioGroup>
          </FieldSet>
          {dataset.visibility === "members" && (
            <FieldDescription>
              While the dataset sits at “members”, published apps and maps that reference it render
              it as unavailable to anyone outside the holding projects.
            </FieldDescription>
          )}
        </FieldGroup>
        <div className="flex justify-end">
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
            type="button"
            variant="outline"
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
