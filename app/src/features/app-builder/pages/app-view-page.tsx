import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { Copy, Link2, LayoutDashboard, Pencil, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { RouterButton } from "#/components/router-button";
import { Button } from "#/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { errorMessage } from "#/lib/errors";
import { api } from "#convex/_generated/api";

import { AppCanvasView } from "../components/app-canvas";
import { copyShareUrl, ShareDialog } from "../components/share-dialog";
import { AppDatasetsProvider } from "../data";
import type { AppDoc } from "../use-app-editor";

function Spinner() {
  return (
    <div className="flex min-h-100 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
    </div>
  );
}

/** Not found and not shared read the same — an id's existence never leaks. */
function AppNotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <Empty className="min-h-80 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboard />
          </EmptyMedia>
          <EmptyTitle>App not found</EmptyTitle>
          <EmptyDescription>
            This app doesn't exist, or its owner hasn't shared it with you.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <RouterButton to="/apps">Go to your apps</RouterButton>
        </EmptyContent>
      </Empty>
    </main>
  );
}

function ViewerActions({ app }: { app: AppDoc }) {
  const navigate = useNavigate(),
    duplicate = useMutation(api.appBuilder.apps.duplicate),
    [sharing, setSharing] = useState(false);
  if (app.canEdit) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSharing(true);
          }}
        >
          <Share2 />
          Share
        </Button>
        <RouterButton to="/apps/$appId/edit" params={{ appId: app._id }}>
          <Pencil />
          Edit app
        </RouterButton>
        <ShareDialog
          appId={app._id}
          sharing={app.sharing}
          open={sharing}
          onOpenChange={setSharing}
        />
      </>
    );
  }
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void copyShareUrl(app._id);
        }}
      >
        <Link2 />
        Copy link
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void (async () => {
            try {
              const copyId = await duplicate({ appId: app._id });
              toast.success("Copied to your apps");
              await navigate({ params: { appId: copyId }, to: "/apps/$appId/edit" });
            } catch (error) {
              toast.error(errorMessage(error, "Couldn't copy the app."));
            }
          })();
        }}
      >
        <Copy />
        Make a copy
      </Button>
    </>
  );
}

/**
 * The shared app (/apps/$appId) — what a share link opens. Read-only for
 * everyone; the creator also gets Edit and Share.
 */
export function AppViewPage({ appId }: { appId: string }) {
  const app = useQuery({ ...convexQuery(api.appBuilder.apps.get, { appId }) }).data;
  if (app === undefined) {
    return <Spinner />;
  }
  if (app === null) {
    return <AppNotFound />;
  }
  return (
    <main className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{app.title}</h1>
          {app.description !== undefined && (
            <p className="mt-1 max-w-3xl text-muted-foreground">{app.description}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {app.ownerName === undefined ? "" : `By ${app.ownerName} · `}Updated{" "}
            {new Date(app.updatedAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ViewerActions app={app} />
        </div>
      </div>
      {app.widgets.length === 0 ? (
        <Empty className="min-h-80 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard />
            </EmptyMedia>
            <EmptyTitle>Nothing here yet</EmptyTitle>
            <EmptyDescription>
              {app.canEdit
                ? "Open the builder to add maps, charts and tables."
                : "The owner hasn't added anything to this app yet."}
            </EmptyDescription>
          </EmptyHeader>
          {app.canEdit && (
            <EmptyContent>
              <RouterButton to="/apps/$appId/edit" params={{ appId: app._id }}>
                <Pencil />
                Open the builder
              </RouterButton>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <AppDatasetsProvider datasetIds={app.datasetIds}>
          <AppCanvasView widgets={app.widgets} />
        </AppDatasetsProvider>
      )}
    </main>
  );
}
