import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation } from 'convex/react'
import { useForm } from '@tanstack/react-form'
import { z } from 'zod'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { RouterButton } from '@/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { JsonEditor } from '@/components/ui/json-editor'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { ArrowLeft, Save, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/schemas/$schemaId/edit')({
  component: EditSchemaPage,
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

function EditSchemaPage() {
  const { schemaId } = Route.useParams()
  const navigate = useNavigate()
  const schema = useQuery(api.schemas.get, { schemaId: schemaId as Id<'schemas'> })
  const entries = useQuery(api.entries.list, { schemaId: schemaId as Id<'schemas'> })
  const updateSchema = useMutation(api.schemas.update)

  if (schema === undefined || entries === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  if (!schema) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <p className="text-muted-foreground mb-4">Schema not found.</p>
          <RouterButton to="/schemas">Back to Schemas</RouterButton>
        </CardContent>
      </Card>
    )
  }

  const hasEntries = entries.length > 0

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 sm:px-0">
      <div className="mb-6">
        <Breadcrumb className="mb-4">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/schemas" />}>Schemas</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/schemas/$schemaId" params={{ schemaId }} />}>
                {schema.title}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Edit</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4">
          <RouterButton variant="ghost" size="sm" to="/schemas/$schemaId" params={{ schemaId }} className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </RouterButton>
          <h1 className="text-3xl font-bold text-primary">Edit Schema</h1>
        </div>
      </div>

      {hasEntries ? (
        <MetadataEditForm
          schemaId={schemaId}
          title={schema.title}
          description={schema.description}
          updateSchema={updateSchema}
          navigate={navigate}
        />
      ) : (
        <FullSchemaEditForm
          schemaId={schemaId}
          currentSchema={schema.schema}
          updateSchema={updateSchema}
          navigate={navigate}
        />
      )}
    </div>
  )
}

function MetadataEditForm({
  schemaId,
  title,
  description,
  updateSchema,
  navigate,
}: {
  schemaId: string
  title: string
  description: string
  updateSchema: ReturnType<typeof useMutation<typeof api.schemas.update>>
  navigate: ReturnType<typeof useNavigate>
}) {
  const form = useForm({
    defaultValues: { title, description },
    onSubmit: async ({ value }) => {
      try {
        await updateSchema({
          schemaId: schemaId as Id<'schemas'>,
          title: value.title,
          description: value.description,
        })
        toast.success('Schema updated!')
        navigate({ to: '/schemas/$schemaId', params: { schemaId } })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update schema.')
      }
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schema Info</CardTitle>
        <CardDescription>
          <span className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
            This schema has entries — only the title and description can be changed to preserve data integrity.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            form.handleSubmit()
          }}
          className="space-y-4"
        >
          <form.Field
            name="title"
            validators={{
              onChange: z.string().min(1, 'Title is required.'),
              onBlur: z.string().min(1, 'Title is required.'),
            }}
          >
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
                {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                  <p className="text-sm text-destructive">{field.state.meta.errors[0]?.message ?? String(field.state.meta.errors[0])}</p>
                )}
              </div>
            )}
          </form.Field>

          <form.Field
            name="description"
            validators={{
              onChange: z.string().min(1, 'Description is required.'),
              onBlur: z.string().min(1, 'Description is required.'),
            }}
          >
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  rows={3}
                />
                {field.state.meta.isTouched && field.state.meta.errors.length > 0 && (
                  <p className="text-sm text-destructive">{field.state.meta.errors[0]?.message ?? String(field.state.meta.errors[0])}</p>
                )}
              </div>
            )}
          </form.Field>

          <form.Subscribe selector={(state) => [state.isSubmitting]}>
            {([isSubmitting]) => (
              <Button type="submit" disabled={isSubmitting}>
                <Save className="h-4 w-4 mr-2" />
                {isSubmitting ? 'Saving…' : 'Save Changes'}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  )
}

function FullSchemaEditForm({
  schemaId,
  currentSchema,
  updateSchema,
  navigate,
}: {
  schemaId: string
  currentSchema: unknown
  updateSchema: ReturnType<typeof useMutation<typeof api.schemas.update>>
  navigate: ReturnType<typeof useNavigate>
}) {
  const form = useForm({
    defaultValues: {
      json: JSON.stringify(currentSchema, null, 2),
    },
    onSubmit: async ({ value }) => {
      const parsed = JSON.parse(value.json)
      try {
        await updateSchema({ schemaId: schemaId as Id<'schemas'>, schema: parsed })
        toast.success('Schema updated!')
        navigate({ to: '/schemas/$schemaId', params: { schemaId } })
      } catch (err) {
        const message =
          err != null && typeof err === 'object' && 'data' in err && typeof err.data === 'string'
            ? err.data
            : err instanceof Error
              ? err.message
              : 'Failed to update schema.'
        toast.error(message)
      }
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>JSON Schema</CardTitle>
        <CardDescription>
          Edit the full schema definition. Must include <code>title</code> and <code>description</code> fields.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            form.handleSubmit()
          }}
          className="space-y-4"
        >
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
                <Label id="schema-json-label">Schema JSON</Label>
                <JsonEditor
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(value) => field.handleChange(value)}
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
                <Save className="h-4 w-4 mr-2" />
                {isSubmitting ? 'Saving…' : 'Save Schema'}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  )
}
