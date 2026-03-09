import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useRef } from 'react'
import { useForm } from '@tanstack/react-form'
import { useMutation } from 'convex/react'
import { z } from 'zod'
import { api } from '../../../convex/_generated/api'
import { Button } from '#/components/ui/button'
import { RouterButton } from '#/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Textarea } from '#/components/ui/textarea'
import { Label } from '#/components/ui/label'
import { Upload, FileJson, ArrowLeft } from 'lucide-react'
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (event) => {
      form.setFieldValue('json', (event.target?.result as string) ?? '')
    }
    reader.readAsText(file)
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
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileJson className="h-4 w-4 mr-2" />
                  Choose File
                </Button>
                {fileName && (
                  <span className="text-sm text-muted-foreground">{fileName}</span>
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
                onBlur: schemaJsonValidator,
                onSubmit: schemaJsonValidator,
              }}
            >
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor="schema-json">Paste JSON Schema</Label>
                  <Textarea
                    id="schema-json"
                    placeholder={'{\n  "title": "My Schema",\n  "description": "...",\n  "type": "object",\n  "properties": {}\n}'}
                    className="min-h-64 font-mono text-sm"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      field.handleChange(e.target.value)
                      if (fileName) setFileName(null)
                    }}
                    aria-describedby="schema-json-errors"
                  />
                  {field.state.meta.errors.length > 0 && (
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
