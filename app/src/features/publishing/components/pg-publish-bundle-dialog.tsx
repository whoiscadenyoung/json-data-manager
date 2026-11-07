import { Button } from "@caden/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { useQuery } from "@tanstack/react-query";
import { Globe, Link2, Lock, Rocket, Users } from "lucide-react";
import { useState } from "react";

import { preflightQueryOptions, type VisibilityLevel } from "#/lib/store/visibility";

/**
 * The bundle press's share dialog (issue #260, ADR 0022): the press is the
 * convenience closure over the project's per-artifact publishes (D6), and
 * its target visibility rung rides the same closure rule — the preflight
 * report runs HERE (a preview; the press re-derives the plan server-side
 * when it stamps the member rows), the confirm starts the press at the
 * chosen rung, and the widening itself lands in ONE transaction after the
 * freeze legs (`visibility_apply`). A blocker (a foreign pin the caller
 * can't widen) is named in the report and caps the share at min(closure) —
 * never a silent widen, never a silent leak.
 */

const OPTIONS: ReadonlyArray<{
  value: VisibilityLevel;
  label: string;
  description: string;
  icon: typeof Lock;
}> = [
  {
    description: "Only this project's members see the promoted collection and its data.",
    icon: Lock,
    label: "Project members",
    value: "members",
  },
  {
    description: "Every signed-in member of this workspace can see the published bundle.",
    icon: Users,
    label: "Anyone signed in",
    value: "signed-in",
  },
  {
    description:
      "Visitors holding a link can read the published bundle without signing in — enforced on the frozen data now; anonymous serving itself ships with public serving.",
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

export function PgPublishBundleDialog({
  onConfirm,
  onOpenChange,
  open,
  projectId,
}: {
  /** Starts the press at the chosen rung (the dialog closes itself). */
  onConfirm: (visibility: VisibilityLevel) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
}) {
  const [target, setTarget] = useState<VisibilityLevel>("signed-in"),
    reportQuery = useQuery({
      ...preflightQueryOptions({ artifactId: projectId, kind: "project", target }),
      enabled: open,
    }),
    report = reportQuery.data;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish bundle</DialogTitle>
          <DialogDescription>
            Freezes every never-published dataset and promotes the project's collection. Choose who
            the published bundle is visible to — widening checks every referenced artifact first.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend className="sr-only">Who can see the published bundle</FieldLegend>
            <RadioGroup
              value={target}
              onValueChange={(value) => {
                const next = OPTIONS.find((option) => option.value === value);
                if (next !== undefined) {
                  setTarget(next.value);
                }
              }}
            >
              {OPTIONS.map((option) => {
                const Icon = option.icon,
                  id = `bundle-visibility-${option.value}`;
                return (
                  <FieldLabel key={option.value} htmlFor={id}>
                    <Field orientation="horizontal">
                      <Icon />
                      <FieldContent>
                        <FieldTitle>{option.label}</FieldTitle>
                        <FieldDescription>{option.description}</FieldDescription>
                      </FieldContent>
                      <RadioGroupItem id={id} value={option.value} />
                    </Field>
                  </FieldLabel>
                );
              })}
            </RadioGroup>
          </FieldSet>
          {reportQuery.isFetching && (
            <p className="text-sm text-muted-foreground">Checking the project's references…</p>
          )}
          {report !== undefined && (
            <div className="flex flex-col gap-2 text-sm">
              {report.promotions.length > 0 ? (
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                  <p className="font-medium">
                    Sharing at “{report.target}” also widens {report.promotions.length} referenced{" "}
                    {report.promotions.length === 1 ? "artifact" : "artifacts"} — review:
                  </p>
                  <ul className="mt-1 list-inside list-disc text-muted-foreground">
                    {report.promotions.map((promotion) => (
                      <li key={`${promotion.kind}:${promotion.id}`}>
                        {promotion.name} — {promotion.kind}, {promotion.from} → {promotion.to}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted-foreground">No referenced artifact needs widening.</p>
              )}
              {report.blockers.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                  <p className="font-medium">
                    {report.blockers.length} referenced{" "}
                    {report.blockers.length === 1 ? "artifact" : "artifacts"} can't be widened by
                    you.
                  </p>
                  <ul className="mt-1 list-inside list-disc text-muted-foreground">
                    {report.blockers.map((blocker) => (
                      <li key={`${blocker.kind}:${blocker.id}`}>
                        {blocker.name} — {blocker.kind}, stays at “{blocker.current}” (owned by
                        another project or locked)
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-muted-foreground">
                    Effective access stays “{report.effective}” — request access to the blocked data
                    or pick different data. Nothing is widened past it.
                  </p>
                </div>
              )}
            </div>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onConfirm(target);
            }}
            type="button"
          >
            <Rocket className="mr-2 h-4 w-4" />
            Publish at “{target}”
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
