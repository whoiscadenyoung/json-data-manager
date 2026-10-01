import { Component, type ReactNode } from "react";

/**
 * Catches render-thrown query errors and renders `fallback` instead of
 * crashing the route. Raw convex/react subscriptions rethrow any errored
 * query during render (the installed client: `if (result instanceof Error)
 * { throw result; }`), so a stage-8 by-id denial (app/convex/auth.ts's
 * `assertDatasetsVisible` — designed to be indistinguishable from a missing
 * dataset) would otherwise hit TanStack Router's default error screen,
 * unreachable past the route's own not-found card.
 *
 * Every by-id route wraps its content with this boundary and hands it the
 * same not-found card a null read gets, so a foreign/author-restricted id
 * reads exactly as a deleted one — never a crash, never an infinite spinner
 * (the projects/index.tsx never-a-silent-hang rule).
 */
export class QueryErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey?: string },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { resetKey?: string }) {
    // The boundary must not pin one id's error across the route instance's
    // lifetime (issue #135, defect 6): after dataset A 404s, opening dataset
    // B in the same route instance reused the fallen boundary and showed
    // "Not Found" for a dataset that exists. A changed `resetKey` (the route
    // param) clears the error so the next id renders fresh — the same
    // semantics as react-error-boundary's `resetKeys`.
    if (this.state.hasError && this.props.resetKey !== prevProps.resetKey) {
      // oxlint-disable-next-line react/no-did-update-set-state -- the documented error-boundary reset pattern (react-error-boundary's resetKeys does the same): clearing the flag here re-renders the children for the new id exactly once.
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: unknown) {
    // The denial renders as "not found" on purpose, but the error itself is
    // never swallowed silently — it is logged for debugging.
    console.error(error);
  }

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
