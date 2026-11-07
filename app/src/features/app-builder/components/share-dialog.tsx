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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@caden/ui/components/input-group";
import { RadioGroup, RadioGroupItem } from "@caden/ui/components/radio-group";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Globe, Link2, Lock, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "#/lib/errors";
import * as appsStore from "#/lib/store/apps";
import {
  isWidening,
  visibilityApply,
  visibilityPreflight,
  type PreflightReport,
  type VisibilityLevel,
} from "#/lib/store/visibility";

/** The app's share URL — the viewer route, on whatever origin the app is served from. */
export function shareUrlFor(appId: string): string {
  return `${window.location.origin}/apps/${appId}`;
}

export async function copyShareUrl(appId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(shareUrlFor(appId));
    toast.success("Link copied");
  } catch {
    toast.error("Couldn't copy — select the link and copy it manually.");
  }
}

const OPTIONS: ReadonlyArray<{
  value: VisibilityLevel;
  label: string;
  description: string;
  icon: typeof Lock;
}> = [
  {
    description: "Only the app project's members can open it.",
    icon: Lock,
    label: "Project members",
    value: "members",
  },
  {
    description:
      "Every signed-in member of this workspace can open it. They see only the data they already have access to.",
    icon: Users,
    label: "Anyone signed in",
    value: "signed-in",
  },
  {
    description:
      "Visitors holding the URL can open it without signing in — anonymous serving reads the published snapshot (frozen rows and tiles), never the live data.",
    icon: Link2,
    label: "Anyone with the link",
    value: "link",
  },
  {
    description: "Like the link level, and listed in the explorers.",
    icon: Globe,
    label: "Public",
    value: "public",
  },
];

/** The link field's liveness line per rung (#261 — what the copied URL actually does). */
const LINK_NOTES: Record<VisibilityLevel, string> = {
  members: "The link only opens for the project's members while the app sits at “members”.",
  "signed-in":
    "The link opens for any signed-in member of this workspace — anonymous visitors are asked to sign in.",
  link: "This link is live: anyone holding it opens the app without signing in.",
  public:
    "This link is live for everyone — anonymous visitors included, and the app is listed in the explorers.",
};

function linkNoteFor(visibility: VisibilityLevel, pending: VisibilityLevel | undefined): string {
  if (pending !== undefined) {
    return `Confirming the share at “${pending}” — the link's audience updates with it.`;
  }
  return LINK_NOTES[visibility];
}

/** The diff-style report ("sharing publicly also widens 2 datasets and 1 map — review"). */
function PromotionNotice({ report }: { report: PreflightReport }) {
  if (report.promotions.length === 0) {
    return <p className="text-sm text-muted-foreground">No referenced artifact needs widening.</p>;
  }
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
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
  );
}

/** The blockers section — a foreign member below the target caps the share; never silent. */
function BlockerNotice({ report }: { report: PreflightReport }) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <p className="font-medium">
        {report.blockers.length} referenced{" "}
        {report.blockers.length === 1 ? "artifact" : "artifacts"} can't be widened by you.
      </p>
      <ul className="mt-1 list-inside list-disc text-muted-foreground">
        {report.blockers.map((blocker) => (
          <li key={`${blocker.kind}:${blocker.id}`}>
            {blocker.name} — {blocker.kind}, stays at “{blocker.current}” (owned by another project
            or locked)
          </li>
        ))}
      </ul>
      <p className="mt-1 text-muted-foreground">
        Effective access stays “{report.effective}” — request access to the blocked data or pick
        different data. Nothing is widened past it.
      </p>
    </div>
  );
}

export function ShareDialog({
  appId,
  visibility,
  open,
  onOpenChange,
}: {
  appId: string;
  visibility: VisibilityLevel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient(),
    updateDetails = useMutation({
      mutationFn: async (args: { appId: string; visibility: VisibilityLevel }) =>
        await appsStore.updateDetails(args),
    }),
    [pending, setPending] = useState<VisibilityLevel | undefined>(),
    [report, setReport] = useState<PreflightReport | null>(null),
    [reportLoading, setReportLoading] = useState(false),
    [copied, setCopied] = useState(false),
    resetPending = () => {
      setPending(undefined);
      setReport(null);
    },
    // Narrowing needs no closure walk — the plain RLS'd write lands it (the
    // RPCs are widening-only by design).
    setVisibilityDirect = async (next: VisibilityLevel) => {
      setPending(next);
      try {
        const affected = await updateDetails.mutateAsync({ appId, visibility: next });
        if (affected === 0) {
          // RLS answered with 0 rows — this viewer cannot edit the app; the
          // radio stays honest instead of pretending the flip landed.
          toast.error("Couldn't change visibility — only a project editor can edit it.");
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't change visibility."));
      } finally {
        resetPending();
      }
    },
    // Widening runs the closure preflight FIRST (§6.2): nothing moves until
    // the diff-style report is confirmed, and the confirm applies every
    // promotion atomically through the apply RPC (the app row itself is one
    // of the promotions).
    setVisibilityWidening = async (next: VisibilityLevel) => {
      setPending(next);
      setReportLoading(true);
      try {
        setReport(await visibilityPreflight({ artifactId: appId, kind: "app", target: next }));
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't check the share's references."));
        resetPending();
      } finally {
        setReportLoading(false);
      }
    },
    confirmWidening = async () => {
      if (pending === undefined) {
        return;
      }
      try {
        const outcome = await visibilityApply({ artifactId: appId, kind: "app", target: pending });
        void queryClient.invalidateQueries({ queryKey: ["pg:apps"] });
        void queryClient.invalidateQueries({ queryKey: ["pg:datasets"] });
        if (outcome.blockers.length > 0) {
          toast.warning(
            `Shared, but effective access is “${outcome.effective}” — ${outcome.blockers.length} referenced artifact(s) cap it. Request access or pick different data.`,
          );
        } else {
          toast.success(
            `Shared at “${outcome.target}” — ${outcome.applied.length} referenced artifact(s) widened with it.`,
          );
        }
        onOpenChange(false);
      } catch (error) {
        toast.error(errorMessage(error, "The share didn't land."));
      } finally {
        resetPending();
      }
    },
    onPick = (next: VisibilityLevel) => {
      if (next === visibility || pending !== undefined) {
        return;
      }
      if (isWidening(visibility, next)) {
        void setVisibilityWidening(next);
      } else {
        void setVisibilityDirect(next);
      }
    };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending === undefined) {
          onOpenChange(next);
        } else {
          resetPending();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share app</DialogTitle>
          <DialogDescription>
            Choose who can open this app. Widening checks every dataset, map and layer the app
            references first — nothing widens without your confirm.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend className="sr-only">Who can open this app</FieldLegend>
            <RadioGroup
              value={pending ?? visibility}
              disabled={pending !== undefined}
              onValueChange={(value) => {
                const next = OPTIONS.find((option) => option.value === value);
                if (next !== undefined) {
                  onPick(next.value);
                }
              }}
            >
              {OPTIONS.map((option) => {
                const Icon = option.icon,
                  id = `app-visibility-${option.value}`;
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
          {reportLoading && (
            <p className="text-sm text-muted-foreground">Checking the app's references…</p>
          )}
          {report !== null && pending !== undefined && (
            <div className="flex flex-col gap-2">
              <PromotionNotice report={report} />
              {report.blockers.length > 0 && <BlockerNotice report={report} />}
              <div className="flex justify-end gap-2">
                <Button onClick={resetPending} type="button" variant="outline">
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    void confirmWidening();
                  }}
                  type="button"
                >
                  Share at “{pending}”
                  {report.promotions.length > 0
                    ? ` (${report.promotions.length} widened)`
                    : undefined}
                </Button>
              </div>
            </div>
          )}
          <Field>
            <FieldLabel htmlFor="app-share-link">Link</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id="app-share-link"
                readOnly
                value={shareUrlFor(appId)}
                onFocus={(event) => {
                  event.target.select();
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="sm"
                  onClick={() => {
                    void copyShareUrl(appId).then(() => {
                      setCopied(true);
                      return setTimeout(() => {
                        setCopied(false);
                      }, 1500);
                    });
                  }}
                >
                  {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                  Copy
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>{linkNoteFor(visibility, pending)}</FieldDescription>
          </Field>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}
