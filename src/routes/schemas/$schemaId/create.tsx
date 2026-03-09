import { createFileRoute, Link } from '@tanstack/react-router'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import Form from '@rjsf/shadcn'
import validator from '@rjsf/validator-ajv8'
import { RouterButton } from '@/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, Check } from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/schemas/$schemaId/create')({
  component: CreateEntryPage,
})

function CreateEntryPage() {
  const { schemaId } = Route.useParams()
  const schema = useQuery(api.schemas.get, { schemaId: schemaId as Id<'schemas'> })
  const createEntry = useMutation(api.entries.create)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [lastCreatedEntryId, setLastCreatedEntryId] = useState<string | null>(null)

  const handleSubmit = async (data: any) => {
    if (!schemaId || !data.formData) return
    
    setIsSubmitting(true)
    
    try {
      const entryId = await createEntry({
        schemaId: schemaId as Id<'schemas'>,
        data: data.formData,
      })
      
      setLastCreatedEntryId(entryId)
      toast.success("Entry created successfully!")
      
      // Reset form by forcing re-render
      window.location.reload()
    } catch (error) {
      console.error('Error creating entry:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to create entry')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (schema === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (!schema) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Schema Not Found</CardTitle>
          <CardDescription className="mb-4">
            The schema you're looking for doesn't exist or has been deleted.
          </CardDescription>
          <RouterButton to="/schemas">Back to Schemas</RouterButton>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <Breadcrumb className="mb-2">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/schemas" />}>Schemas</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/schemas/$schemaId" params={{ schemaId }} />}>{schema.title}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Create Entry</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4 mb-4">
          <RouterButton variant="outline" size="sm" to="/schemas/$schemaId" params={{ schemaId }}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </RouterButton>
          <div>
            <h1 className="text-3xl font-bold text-primary">Create New Entry</h1>
            <p className="text-lg text-muted-foreground mt-2">{schema.description}</p>
          </div>
        </div>
      </div>

      {lastCreatedEntryId && (
        <Card className="mb-6 border-green-200 bg-green-50">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-green-800">
              <Check className="h-4 w-4" />
              <span>
                Entry created successfully!{' '}
                <Link
                  to="/schemas/$schemaId/$entryId"
                  params={{ schemaId, entryId: lastCreatedEntryId }}
                  className="font-semibold underline hover:no-underline"
                >
                  View entry
                </Link>
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Entry Form</CardTitle>
          <CardDescription>
            Fill out the form below to create a new data entry
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form
            schema={schema.schema}
            validator={validator}
            onSubmit={handleSubmit}
            disabled={isSubmitting}
            uiSchema={{
              'ui:submitButtonOptions': {
                submitText: isSubmitting ? 'Creating...' : 'Create Entry',
                norender: false,
                props: {
                  disabled: isSubmitting,
                  className: 'w-full px-4 py-3 rounded bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors shadow-sm hover:shadow disabled:opacity-50 disabled:cursor-not-allowed'
                }
              }
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
