import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { RouterButton } from '@/components/ui/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Plus, Download, Calendar, FileText } from 'lucide-react'

export const Route = createFileRoute('/schemas/$schemaId/')({
  component: SchemaDetailPage,
})

function SchemaDetailPage() {
  const { schemaId } = Route.useParams()
  const schema = useQuery(api.schemas.get, { schemaId: schemaId as Id<'schemas'> })
  const entries = useQuery(api.entries.list, { schemaId: schemaId as Id<'schemas'> })

  const handleExport = () => {
    if (!entries) return

    const exportData = entries.map(entry => entry.data)
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${schema?.title || 'schema'}-entries.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (schema === undefined || entries === undefined) {
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
    <div>
      <div className="flex justify-between items-start mb-8">
        <div>
          <nav className="text-sm text-muted-foreground mb-2">
            <Link to="/schemas" className="hover:underline">Schemas</Link>
            <span className="mx-2">/</span>
            <span>{schema.title}</span>
          </nav>
          <h1 className="text-3xl font-bold text-primary">{schema.title}</h1>
          <p className="text-lg text-muted-foreground mt-2">{schema.description}</p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={handleExport}
            disabled={entries.length === 0}
            variant="outline"
          >
            <Download className="h-4 w-4 mr-2" />
            Export ({entries.length})
          </Button>
          <RouterButton to="/schemas/$schemaId/create" params={{ schemaId }}>
            <Plus className="h-4 w-4 mr-2" />
            Create Entry
          </RouterButton>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Schema Definition
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted rounded-lg p-4 overflow-x-auto">
              <pre className="text-sm">
                {JSON.stringify(schema.schema, null, 2)}
              </pre>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              Entries ({entries.length})
            </CardTitle>
            <CardDescription>
              Data entries created from this schema
            </CardDescription>
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <div className="text-center py-8">
                <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
                  <Plus className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground mb-4">No entries created yet</p>
                <RouterButton to="/schemas/$schemaId/create" params={{ schemaId }}>
                  Create First Entry
                </RouterButton>
              </div>
            ) : (
              <div className="space-y-3">
                {entries.map((entry) => (
                  <Card key={entry._id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-center text-sm text-muted-foreground mb-2">
                        <Calendar className="h-4 w-4 mr-2" />
                        {new Date(entry._creationTime).toLocaleString()}
                      </div>
                      <div className="text-sm font-mono bg-muted p-2 rounded overflow-x-auto mb-3">
                        {JSON.stringify(entry.data, null, 2).slice(0, 200)}
                        {JSON.stringify(entry.data).length > 200 && '...'}
                      </div>
                      <RouterButton size="sm" className="w-full" to="/schemas/$schemaId/$entryId" params={{ schemaId, entryId: entry._id }}>
                        View Details
                      </RouterButton>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
