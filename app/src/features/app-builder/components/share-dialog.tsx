import { useMutation } from "convex/react";
import { Check, Copy, Globe, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "#/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "#/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";
import type { Sharing } from "#convex/appBuilder/validators";

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
  value: Sharing;
  label: string;
  description: string;
  icon: typeof Lock;
}> = [
  {
    description: "Only you can open this app.",
    icon: Lock,
    label: "Private",
    value: "private",
  },
  {
    description:
      "Anyone signed in to this workspace can open it with the link. They see only the datasets they already have access to.",
    icon: Globe,
    label: "Anyone with the link",
    value: "link",
  },
];

export function ShareDialog({
  appId,
  sharing,
  open,
  onOpenChange,
}: {
  appId: string;
  sharing: Sharing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateDetails = useMutation(api.appBuilder.apps.updateDetails),
    [pending, setPending] = useState<Sharing | undefined>(),
    [copied, setCopied] = useState(false),
    setSharing = async (next: Sharing) => {
      if (next === sharing) {
        return;
      }
      setPending(next);
      try {
        await updateDetails({ appId, sharing: next });
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't change sharing."));
      } finally {
        setPending(undefined);
      }
    };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share app</DialogTitle>
          <DialogDescription>
            Choose who can open this app's link. Only you can edit it.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FieldSet>
            <FieldLegend className="sr-only">Who can open this app</FieldLegend>
            <RadioGroup
              value={pending ?? sharing}
              disabled={pending !== undefined}
              onValueChange={(value) => {
                const next = OPTIONS.find((option) => option.value === value);
                if (next !== undefined) {
                  void setSharing(next.value);
                }
              }}
            >
              {OPTIONS.map((option) => {
                const Icon = option.icon,
                  id = `app-sharing-${option.value}`;
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
            {sharing === "private" && pending === undefined && (
              <FieldDescription>
                The link only works for you while the app is private.
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}
