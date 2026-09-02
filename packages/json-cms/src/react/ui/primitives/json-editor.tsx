import { Suspense, lazy, useSyncExternalStore } from "react";

import { cn } from "../lib/utils.js";
import type { JsonEditorProps } from "./json-editor-impl.js";

const JsonEditorImpl = lazy(async () => {
  const mod = await import("./json-editor-impl.js");
  return { default: mod.JsonEditor };
});

const subscribe = () => () => {};

// SSR-safe "are we on the client yet?" check: returns false during the server
// render and the initial hydration pass, then true once running in the browser.
function useIsClient() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

function JsonEditorFallback({ height = "256px" }: { height?: string }) {
  return <div className={cn("rounded-md border border-input")} style={{ height }} />;
}

/**
 * Client-only wrapper around the CodeMirror-based JSON editor.
 *
 * The editor pulls in `codemirror-json-schema` and its CommonJS transitive
 * deps, which Node's native ESM loader can't resolve when they're externalized
 * for SSR. That errors the server render and forces TanStack Start to fall back
 * to client rendering for the whole route. Since a code editor only works in
 * the browser anyway, we defer loading the entire editor to the client via a
 * dynamic import gated behind a mount check — the module (and its deps) is
 * never evaluated on the server, so the rest of the page still SSRs cleanly.
 */
export function JsonEditor(props: JsonEditorProps) {
  const isClient = useIsClient();

  if (!isClient) {
    return <JsonEditorFallback height={props.height} />;
  }

  return (
    <Suspense fallback={<JsonEditorFallback height={props.height} />}>
      <JsonEditorImpl {...props} />
    </Suspense>
  );
}
