import { useMemo } from 'react'
import ReactCodeMirror, { EditorView } from '@uiw/react-codemirror'
import { githubLight, githubDark } from '@uiw/codemirror-theme-github'
import { json } from '@codemirror/lang-json'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { syntaxTree } from '@codemirror/language'
import { useColorScheme } from '#/hooks/use-color-scheme'
import { cn } from '#/lib/utils'

const jsonLinter = linter((view): Diagnostic[] => {
  const diagnostics: Diagnostic[] = []
  const doc = view.state.doc.toString()

  if (!doc.trim()) return diagnostics

  // Surface parse errors from the lezer syntax tree
  syntaxTree(view.state)
    .cursor()
    .iterate((node) => {
      if (node.type.isError) {
        diagnostics.push({
          from: node.from,
          to: Math.max(node.to, node.from + 1),
          severity: 'error',
          message: 'JSON syntax error',
        })
      }
    })

  if (diagnostics.length > 0) return diagnostics

  // Semantic validation (title / description)
  try {
    const parsed = JSON.parse(doc)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      diagnostics.push({
        from: 0,
        to: doc.length,
        severity: 'error',
        message: 'Schema must be a JSON object',
      })
      return diagnostics
    }

    const obj = parsed as Record<string, unknown>

    if (!obj.title || typeof obj.title !== 'string' || !obj.title.trim()) {
      diagnostics.push({
        from: 0,
        to: doc.length,
        severity: 'warning',
        message: 'Schema must have a non-empty "title" property',
      })
    }

    if (!obj.description || typeof obj.description !== 'string' || !obj.description.trim()) {
      diagnostics.push({
        from: 0,
        to: doc.length,
        severity: 'warning',
        message: 'Schema must have a non-empty "description" property',
      })
    }
  } catch {
    // parse errors already surfaced via syntax tree above
  }

  return diagnostics
})

// Blend CodeMirror's internals with the site's design tokens
const baseTheme = EditorView.theme({
  '&': {
    fontSize: '0.875rem',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': { borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '2.5rem', paddingRight: '0.5rem' },
})

interface JsonEditorProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  'aria-describedby'?: string
  'aria-labelledby'?: string
}

export function JsonEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  'aria-describedby': ariaDescribedBy,
  'aria-labelledby': ariaLabelledBy,
}: JsonEditorProps) {
  const colorScheme = useColorScheme()

  const extensions = useMemo(
    () => [
      json(),
      lintGutter(),
      jsonLinter,
      baseTheme,
      EditorView.contentAttributes.of({
        ...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {}),
        ...(ariaLabelledBy ? { 'aria-labelledby': ariaLabelledBy } : {}),
      }),
    ],
    [ariaDescribedBy, ariaLabelledBy],
  )

  return (
    <div
      className={cn(
        'rounded-md border border-input overflow-hidden',
        'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring',
      )}
    >
      <ReactCodeMirror
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        height="256px"
        theme={colorScheme === 'dark' ? githubDark : githubLight}
        extensions={extensions}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          indentOnInput: true,
          closeBrackets: true,
          autocompletion: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
        }}
      />
    </div>
  )
}
