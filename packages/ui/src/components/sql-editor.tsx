import { Suspense, lazy, useSyncExternalStore } from "react";

import type { SqlEditorProps } from "./sql-editor-impl";

const SqlEditorImpl = lazy(async () => {
  const mod = await import("./sql-editor-impl");
  return { default: mod.SqlEditor };
});

const subscribe = () => () => {};

// SSR-safe "are we on the client yet?" (false on the server and the first hydration pass).
function useIsClient() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

function Fallback({ height = "224px" }: { height?: string }) {
  return <div className="rounded-md border border-input" style={{ height }} />;
}

/**
 * Client-only SQL editor. Like the JSON editor, CodeMirror is never evaluated
 * on the server (docs/memory: the editor must stay lazy + `useIsClient`-gated
 * or SSR breaks); the server renders a same-sized empty box.
 */
export function SqlEditor(props: SqlEditorProps) {
  const isClient = useIsClient();
  if (!isClient) {
    return <Fallback height={props.height} />;
  }
  return (
    <Suspense fallback={<Fallback height={props.height} />}>
      <SqlEditorImpl {...props} />
    </Suspense>
  );
}
