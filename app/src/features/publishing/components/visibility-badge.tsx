import { Badge } from "@caden/ui/components/badge";
import { Globe, Link2, Lock, Users } from "lucide-react";

import type { VisibilityLevel } from "@/lib/store/visibility";

const LABELS: Record<VisibilityLevel, { label: string; title: string }> = {
  link: { label: "By link", title: "Anyone with the link can open it." },
  members: { label: "Members only", title: "Only this project's members can open it." },
  public: { label: "Public", title: "Anyone can find and open it." },
  "signed-in": { label: "Signed-in", title: "Anyone who is signed in can open it." },
};

/** Who can open a map or an app, as one chip. */
export function VisibilityBadge({ visibility }: { visibility: VisibilityLevel }) {
  const { label, title } = LABELS[visibility];
  return (
    <Badge title={title} variant={visibility === "members" ? "outline" : "secondary"}>
      {visibility === "public" ? (
        <Globe data-icon="inline-start" />
      ) : visibility === "link" ? (
        <Link2 data-icon="inline-start" />
      ) : visibility === "signed-in" ? (
        <Users data-icon="inline-start" />
      ) : (
        <Lock data-icon="inline-start" />
      )}
      {label}
    </Badge>
  );
}
