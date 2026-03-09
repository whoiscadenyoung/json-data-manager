import { createFileRoute, Link } from '@tanstack/react-router'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { useQuery } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { RouterButton } from '@/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Plus, Download, Calendar, FileText, FilePlus, Pencil, UploadCloud } from 'lucide-react'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

export const Route = createFileRoute('/schemas/$schemaId/')({
  component: SchemaDetailPage,
})

function SchemaDetailPage() {
  const { schemaId } = Route.useParams()
  const schema = useQuery(api.schemas.get, { schemaId: schemaId as Id<'schemas'> })
  const entries = useQuery(api.entries.list, { schemaId: schemaId as Id<'schemas'> })

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleExport = () => {
    if (!entries || !schema) return

    const slug = schema.title.toLowerCase().replace(/\s+/g, '-')
    const schemaFilename = `${slug}-schema.json`

    downloadFile(JSON.stringify(schema.schema, null, 2), schemaFilename)

    setTimeout(() => {
      const entriesData = {
        $schema: schemaFilename,
        entries: entries.map((entry) => entry.data),
      }
      downloadFile(JSON.stringify(entriesData, null, 2), `${slug}-entries.json`)
    }, 100)
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
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-0">
      <div className="flex justify-between items-start mb-8">
        <div>
          <Breadcrumb className="mb-2">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to="/schemas" />}>Schemas</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{schema.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <h1 className="text-3xl font-bold text-primary">{schema.title}</h1>
          <p className="text-lg text-muted-foreground mt-2">{schema.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RouterButton variant="outline" to="/schemas/$schemaId/edit" params={{ schemaId }}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </RouterButton>
          <Button
            onClick={handleExport}
            disabled={entries.length === 0}
            variant="outline"
          >
            <Download className="h-4 w-4 mr-2" />
            Export ({entries.length})
          </Button>
          <RouterButton variant="outline" to="/schemas/$schemaId/bulk-upload" params={{ schemaId }}>
            <UploadCloud className="h-4 w-4 mr-2" />
            Bulk Upload
          </RouterButton>
          <RouterButton to="/schemas/$schemaId/create" params={{ schemaId }}>
            <Plus className="h-4 w-4 mr-2" />
            Create Entry
          </RouterButton>
        </div>
      </div>

      <Tabs defaultValue="entries">
        <TabsList>
          <TabsTrigger value="entries">Entries ({entries.length})</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
        </TabsList>

        <TabsContent value="entries">
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
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FilePlus />
                    </EmptyMedia>
                    <EmptyTitle>No entries yet</EmptyTitle>
                    <EmptyDescription>Add your first entry to this schema.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <RouterButton to="/schemas/$schemaId/create" params={{ schemaId }}>
                      <Plus className="h-4 w-4 mr-2" />
                      Create First Entry
                    </RouterButton>
                  </EmptyContent>
                </Empty>
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
        </TabsContent>

        <TabsContent value="schema">
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
        </TabsContent>
      </Tabs>
    </div>
  )
}
