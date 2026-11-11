/**
 * Nitro plugin (registered in vite.config.ts): starts the `auto` view-refresh
 * drain when the app server boots (issue #305). It is a no-op without
 * `DATABASE_URL` (so builds, tests and dev without the stack are unaffected)
 * and when `VIEW_REFRESH_POLL_MS=0`.
 */
export default function viewRefreshPlugin(): void {
  void import("./entry.server").then(
    (entry) => {
      entry.startRefreshLoop();
    },
    (error: unknown) => {
      console.error("[view-refresh] could not start:", error);
    },
  );
}
