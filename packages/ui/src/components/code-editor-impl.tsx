import { autocompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { lintGutter, linter } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import ReactCodeMirror, { EditorView } from "@uiw/react-codemirror";
import { useMemo, useRef } from "react";

import { useColorScheme } from "../hooks/use-color-scheme";
import { cn } from "../lib/utils";

export interface CodeEditorDiagnostic {
  /** Offsets into the editor text; `to` is exclusive. */
  from: number;
  to: number;
  message: string;
}

export interface CodeCompletion {
  /** What the list shows and what is matched against the typed word. */
  label: string;
  /** What gets inserted (defaults to the label). */
  apply?: string;
  detail?: string;
  info?: string;
  type?: "function" | "variable" | "keyword" | "class";
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  height?: string;
  /** Underlined problems (offsets into `value`). */
  diagnostics?: CodeEditorDiagnostic[];
  /** Autocomplete candidates, filtered by the word before the cursor. */
  completions?: CodeCompletion[];
}

const WORD = /[A-Za-z0-9_."]*/;

const baseTheme = EditorView.theme({
  "&": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: "0.875rem",
  },
  ".cm-scroller": { overflow: "auto" },
});

/** Clamp a diagnostic into the document and give empty ranges one character. */
function clampDiagnostic(item: CodeEditorDiagnostic, length: number): Diagnostic {
  const from = Math.max(0, Math.min(item.from, length));
  const to = Math.max(from, Math.min(item.to, length));
  const widened = to === from && from > 0 ? { from: from - 1, to } : { from, to };
  return { ...widened, message: item.message, severity: "error" };
}

/**
 * The CodeMirror-based text editor behind the view editor's expression and
 * SQL fields: positioned error underlines and a caller-supplied completion
 * list. Load it through `code-editor.tsx` (client-only, lazy).
 */
export function CodeEditor({
  ariaLabel,
  completions = [],
  diagnostics = [],
  height = "120px",
  onChange,
  placeholder,
  value,
}: CodeEditorProps) {
  const colorScheme = useColorScheme(),
    // The extensions read the latest props through refs, so they are built once.
    diagnosticsRef = useRef(diagnostics),
    completionsRef = useRef(completions);
  diagnosticsRef.current = diagnostics;
  completionsRef.current = completions;
  const extensions = useMemo(
    () => [
      lintGutter(),
      linter(
        (view): Diagnostic[] =>
          diagnosticsRef.current.map((item) => clampDiagnostic(item, view.state.doc.length)),
        { delay: 0 },
      ),
      autocompletion({
        override: [
          (context: CompletionContext): CompletionResult | null => {
            const word = context.matchBefore(WORD);
            if (word === null || (word.from === word.to && !context.explicit)) {
              return null;
            }
            return {
              from: word.from,
              options: completionsRef.current.map((item) => ({
                label: item.label,
                apply: item.apply,
                detail: item.detail,
                info: item.info,
                type: item.type,
              })),
              validFor: WORD,
            };
          },
        ],
      }),
      baseTheme,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
    ],
    [ariaLabel],
  );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-input",
        "focus-within:ring-2 focus-within:ring-ring focus-within:outline-none",
      )}
    >
      <ReactCodeMirror
        basicSetup={{
          autocompletion: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          lineNumbers: false,
        }}
        extensions={extensions}
        height={height}
        minHeight={height}
        onChange={onChange}
        placeholder={placeholder}
        theme={colorScheme === "dark" ? githubDark : githubLight}
        value={value}
      />
    </div>
  );
}
