import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;

function subscribeMobile(listener: () => void): () => void {
  const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
}

/**
 * True below the `md` breakpoint. The server snapshot assumes desktop, so the
 * first render — including SSR — renders the desktop shell, then consumers
 * tolerate the flip after hydration (the sidebar swaps to a sheet).
 */
export function useIsMobile() {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches,
    () => false,
  );
}
