import { Spinner } from "#/components/ui/spinner";

/** The app builder pages' whole-page loading state. */
export function PageLoading() {
  return (
    <div className="flex min-h-100 items-center justify-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}
