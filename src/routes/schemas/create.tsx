import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useRef } from 'react'
import { useForm } from '@tanstack/react-form'
import { useMutation } from 'convex/react'
import { z } from 'zod'
import { api } from '../../../convex/_generated/api'
import { Button } from '#/components/ui/button'
import { RouterButton } from '#/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Label } from '#/components/ui/label'
import { JsonEditor } from '#/components/ui/json-editor'
import { Upload, FileJson, ArrowLeft, X } from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/schemas/create')({
  component: CreateSchemaPage,
})

const schemaJsonValidator = z.string().superRefine((val, ctx) => {
  if (!val.trim()) {
    ctx.addIssue({ code: 'custom', message: 'Schema is required.' })
    return z.NEVER
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(val)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid JSON — please check your input.' })
    return z.NEVER
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    ctx.addIssue({ code: 'custom', message: 'Schema must be a JSON object.' })
    return z.NEVER
  }

  const obj = parsed as Record<string, unknown>
  if (!obj.title || typeof obj.title !== 'string' || !obj.title.trim()) {
    ctx.addIssue({ code: 'custom', message: "Schema must have a non-empty 'title' property." })
  }
  if (!obj.description || typeof obj.description !== 'string' || !obj.description.trim()) {
    ctx.addIssue({ code: 'custom', message: "Schema must have a non-empty 'description' property." })
  }
})

function CreateSchemaPage() {
  const navigate = useNavigate()
  const createSchema = useMutation(api.schemas.create)
  const [fileName, setFileName] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const form = useForm({
    defaultValues: {
      json: '',
    },
    onSubmit: async ({ value }) => {
      const parsed = JSON.parse(value.json)
      try {
        const schemaId = await createSchema({ schema: parsed })
        toast.success('Schema created!')
        navigate({ to: '/schemas/$schemaId', params: { schemaId } })
      } catch (err) {
        const message =
          err != null && typeof err === 'object' && 'data' in err && typeof err.data === 'string'
            ? err.data
            : err instanceof Error
              ? err.message
              : 'Failed to create schema.'
        toast.error(message)
      }
    },
  })

  const loadFile = (file: File) => {
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      toast.error('Please upload a .json file.')
      return
    }
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (event) => {
      form.setFieldValue('json', (event.target?.result as string) ?? '')
    }
    reader.readAsText(file)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) loadFile(file)
    e.target.value = ''
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6">
        <RouterButton variant="ghost" to="/schemas" className="mb-4 -ml-2">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Schemas
        </RouterButton>
        <h1 className="text-3xl font-bold text-primary mb-1">Create Schema</h1>
        <p className="text-muted-foreground">
          Upload a JSON file or paste your schema below. It must include <code>title</code> and{' '}
          <code>description</code> fields.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>JSON Schema</CardTitle>
          <CardDescription>
            Choose one: upload a <code>.json</code> file or paste the schema directly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              e.stopPropagation()
              form.handleSubmit()
            }}
            className="space-y-6"
          >
            {/* File upload */}
            <div className="space-y-2">
              <Label>Upload JSON File</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleFileChange}
              />
              <div
                role="button"
                tabIndex={0}
                aria-label="Drop zone: drag a JSON file here or click to browse"
                className={[
                  'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isDragging
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-muted/50',
                ].join(' ')}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => e.key === 'Enter' || e.key === ' ' ? fileInputRef.current?.click() : undefined}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <FileJson className={`h-8 w-8 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
                {fileName ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{fileName}</span>
                    <button
                      type="button"
                      aria-label="Remove file"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        setFileName(null)
                        form.setFieldValue('json', '')
                      }}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-medium">
                      {isDragging ? 'Drop your file here' : 'Drag & drop a JSON file, or click to browse'}
                    </p>
                    <p className="text-xs">.json files only</p>
                  </>
                )}
              </div>
            </div>

            <div className="relative flex items-center gap-3">
              <div className="flex-1 border-t border-border" />
              <span className="text-xs text-muted-foreground uppercase tracking-wide">or</span>
              <div className="flex-1 border-t border-border" />
            </div>

            {/* Textarea */}
            <form.Field
              name="json"
              validators={{
                onChange: schemaJsonValidator,
                onBlur: schemaJsonValidator,
                onSubmit: schemaJsonValidator,
              }}
            >
              {(field) => (
                <div className="space-y-2">
                  <Label id="schema-json-label">Paste JSON Schema</Label>
                  <JsonEditor
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(value) => {
                      field.handleChange(value)
                      if (fileName) setFileName(null)
                    }}
                    placeholder={'{\n  "title": "My Schema",\n  "description": "...",\n  "type": "object",\n  "properties": {}\n}'}
                    aria-labelledby="schema-json-label"
                    aria-describedby="schema-json-errors"
                  />
                  {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                    <ul id="schema-json-errors" className="space-y-1">
                      {field.state.meta.errors.map((error) => (
                        <li
                          key={typeof error === 'string' ? error : error?.message}
                          className="text-sm text-destructive"
                        >
                          {typeof error === 'string' ? error : error?.message ?? String(error)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </form.Field>

            <form.Subscribe selector={(state) => [state.isSubmitting]}>
              {([isSubmitting]) => (
                <Button type="submit" disabled={isSubmitting}>
                  <Upload className="h-4 w-4 mr-2" />
                  {isSubmitting ? 'Creating…' : 'Create Schema'}
                </Button>
              )}
            </form.Subscribe>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
