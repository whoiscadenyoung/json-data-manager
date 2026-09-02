import { json } from "@codemirror/lang-json";
import { syntaxTree } from "@codemirror/language";
import { lintGutter, linter } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import ReactCodeMirror, { EditorView } from "@uiw/react-codemirror";
import { jsonSchemaLinter, stateExtensions, updateSchema } from "codemirror-json-schema";
import { useEffect, useMemo, useRef } from "react";

import { useColorScheme } from "#/hooks/use-color-scheme";
import { cn } from "#/lib/utils";

const jsonLinter = linter((view): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [],
      doc = view.state.doc.toString();

    if (!doc.trim()) {
      return diagnostics;
    }

    // Surface parse errors from the lezer syntax tree
    syntaxTree(view.state)
      .cursor()
      .iterate((node) => {
        if (node.type.isError) {
          diagnostics.push({
            from: node.from,
            message: "JSON syntax error",
            severity: "error",
            to: Math.max(node.to, node.from + 1),
          });
        }
      });

    if (diagnostics.length > 0) {
      return diagnostics;
    }

    // Semantic validation (title / description)
    try {
      const parsed = JSON.parse(doc);

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        diagnostics.push({
          from: 0,
          message: "Schema must be a JSON object",
          severity: "error",
          to: doc.length,
        });
        return diagnostics;
      }

      const obj = parsed as Record<string, unknown>;

      if (!obj.title || typeof obj.title !== "string" || !obj.title.trim()) {
        diagnostics.push({
          from: 0,
          message: 'Schema must have a non-empty "title" property',
          severity: "warning",
          to: doc.length,
        });
      }

      if (!obj.description || typeof obj.description !== "string" || !obj.description.trim()) {
        diagnostics.push({
          from: 0,
          message: 'Schema must have a non-empty "description" property',
          severity: "warning",
          to: doc.length,
        });
      }
    } catch {
      // Parse errors already surfaced via syntax tree above
    }

    return diagnostics;
  }),
  // Blend CodeMirror's internals with the site's design tokens
  baseTheme = EditorView.theme({
    "&": {
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: "0.875rem",
    },
    ".cm-gutters": { borderRight: "1px solid var(--border)" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "2.5rem", paddingRight: "0.5rem" },
    ".cm-scroller": { overflow: "auto" },
  });

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  height?: string;
  /** Suppress the meta-schema linter that checks for object/title/description. Use on data editors. */
  disableSchemaLinting?: boolean;
  /** When provided, validate the editor content against this JSON Schema using codemirror-json-schema. */
  jsonSchema?: object;
  "aria-describedby"?: string;
  "aria-labelledby"?: string;
}

export function JsonEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  height = "256px",
  disableSchemaLinting = false,
  jsonSchema,
  "aria-describedby": ariaDescribedBy,
  "aria-labelledby": ariaLabelledBy,
}: JsonEditorProps) {
  const colorScheme = useColorScheme(),
    viewRef = useRef<EditorView | null>(null),
    enableJsonSchemaLinting = jsonSchema !== undefined;

  // Update the schema in CodeMirror state whenever it changes
  useEffect(() => {
    if (viewRef.current) {
      updateSchema(viewRef.current, jsonSchema);
    }
  }, [jsonSchema]);

  const extensions = useMemo(
    () => [
      json(),
      lintGutter(),
      ...(disableSchemaLinting ? [] : [jsonLinter]),
      // Add schema-based linting extensions (schema value pushed separately via updateSchema)
      ...(enableJsonSchemaLinting ? [...stateExtensions(), linter(jsonSchemaLinter())] : []),
      baseTheme,
      EditorView.contentAttributes.of({
        ...(ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
        ...(ariaLabelledBy ? { "aria-labelledby": ariaLabelledBy } : {}),
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ariaDescribedBy, ariaLabelledBy, disableSchemaLinting, enableJsonSchemaLinting],
  );

  return (
    <div
      className={cn(
        "rounded-md border border-input overflow-hidden",
        "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring",
      )}
    >
      <ReactCodeMirror
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        height={height}
        theme={colorScheme === "dark" ? githubDark : githubLight}
        extensions={extensions}
        placeholder={placeholder}
        onCreateEditor={(view) => {
          viewRef.current = view;
          // Set schema immediately on mount so first validation is instant
          if (jsonSchema !== undefined) {
            updateSchema(view, jsonSchema);
          }
        }}
        basicSetup={{
          allowMultipleSelections: false,
          autocompletion: false,
          closeBrackets: true,
          dropCursor: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          indentOnInput: true,
          lineNumbers: true,
        }}
      />
    </div>
  );
}
