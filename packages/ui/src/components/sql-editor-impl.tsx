import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import ReactCodeMirror, { EditorView, keymap, Prec } from "@uiw/react-codemirror";
import { useMemo } from "react";

import { useColorScheme } from "../hooks/use-color-scheme";
import { cn } from "../lib/utils";

export interface SqlEditorProps {
  ariaLabel?: string;
  height?: string;
  /** Table name to column names, for completion. */
  schema?: Record<string, string[]>;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter. */
  onRun?: () => void;
  placeholder?: string;
  value: string;
}

/** CodeMirror SQL editor (Postgres dialect). Import through `sql-editor.tsx`: it is client-only. */
export function SqlEditor({
  ariaLabel,
  height = "224px",
  onChange,
  onRun,
  placeholder,
  schema,
  value,
}: SqlEditorProps) {
  const colorScheme = useColorScheme();
  const extensions = useMemo(
    () => [
      sql({
        dialect: PostgreSQL,
        ...(schema === undefined ? {} : { schema }),
        upperCaseKeywords: false,
      }),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": ariaLabel ?? "SQL" }),
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              if (onRun !== undefined) {
                onRun();
              }
              return true;
            },
          },
        ]),
      ),
    ],
    [ariaLabel, onRun, schema],
  );
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-input",
        "focus-within:ring-2 focus-within:ring-ring focus-within:outline-none",
      )}
    >
      <ReactCodeMirror
        basicSetup={{ foldGutter: false, highlightActiveLine: false, lineNumbers: true }}
        extensions={extensions}
        height={height}
        onChange={onChange}
        placeholder={placeholder}
        theme={colorScheme === "dark" ? githubDark : githubLight}
        value={value}
      />
    </div>
  );
}
