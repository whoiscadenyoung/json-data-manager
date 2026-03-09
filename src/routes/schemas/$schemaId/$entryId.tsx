import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { RouterButton } from '@/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft, Calendar, Plus } from 'lucide-react'

export const Route = createFileRoute('/schemas/$schemaId/$entryId')({
  component: EntryDetailPage,
})

function EntryDetailPage() {
  const { schemaId, entryId } = Route.useParams()
  const entry = useQuery(api.entries.get, { entryId: entryId as Id<'entries'> })
  const schema = useQuery(api.schemas.get, { schemaId: schemaId as Id<'schemas'> })

  if (entry === undefined || schema === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (!entry || !schema) {
    return (
      <Card className="text-center py-12">
        <CardContent className="pt-6">
          <CardTitle className="mb-2">Entry Not Found</CardTitle>
          <CardDescription className="mb-4">
            The entry you're looking for doesn't exist or has been deleted.
          </CardDescription>
          <RouterButton to="/schemas">Back to Schemas</RouterButton>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <nav className="text-sm text-muted-foreground mb-2">
          <Link to="/schemas" className="hover:underline">Schemas</Link>
          <span className="mx-2">/</span>
          <Link to="/schemas/$schemaId" params={{ schemaId }} className="hover:underline">
            {schema.title}
          </Link>
          <span className="mx-2">/</span>
          <span>Entry Details</span>
        </nav>
        <div className="flex items-center gap-4 mb-4">
          <RouterButton variant="outline" size="sm" to="/schemas/$schemaId" params={{ schemaId }}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Schema
          </RouterButton>
          <div>
            <h1 className="text-3xl font-bold text-primary">Entry Details</h1>
            <div className="flex items-center text-muted-foreground mt-2">
              <Calendar className="h-4 w-4 mr-2" />
              Created {new Date(entry._creationTime).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Entry Data</CardTitle>
          <CardDescription>
            The data stored for this entry
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-muted rounded-lg p-4 overflow-x-auto">
            <pre className="text-sm">
              {JSON.stringify(entry.data, null, 2)}
            </pre>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-center gap-4">
        <RouterButton variant="outline" to="/schemas/$schemaId" params={{ schemaId }}>
          Back to Schema Details
        </RouterButton>
        <RouterButton to="/schemas/$schemaId/create" params={{ schemaId }}>
          <Plus className="h-4 w-4 mr-2" />
          Create Another Entry
        </RouterButton>
      </div>
    </div>
  )
}
