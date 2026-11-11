import { Suspense, lazy, useSyncExternalStore } from "react";

import { cn } from "../lib/utils";
import type { CodeEditorProps } from "./code-editor-impl";

export type { CodeCompletion, CodeEditorDiagnostic, CodeEditorProps } from "./code-editor-impl";

const CodeEditorImpl = lazy(async () => {
  const mod = await import("./code-editor-impl");
  return { default: mod.CodeEditor };
});

const subscribe = () => () => {};

// SSR-safe "are we on the client yet?" check (false on the server render and
// the first hydration pass), as in json-editor.tsx.
function useIsClient() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

function Fallback({ height = "120px" }: { height?: string }) {
  return <div className={cn("rounded-md border border-input")} style={{ height }} />;
}

/**
 * Client-only wrapper around the CodeMirror text editor (expressions and
 * SQL). CodeMirror's CommonJS dependency chain must never be evaluated during
 * SSR, so the implementation is a dynamic import behind a mount check.
 */
export function CodeEditor(props: CodeEditorProps) {
  const isClient = useIsClient();
  if (!isClient) {
    return <Fallback height={props.height} />;
  }
  return (
    <Suspense fallback={<Fallback height={props.height} />}>
      <CodeEditorImpl {...props} />
    </Suspense>
  );
}
