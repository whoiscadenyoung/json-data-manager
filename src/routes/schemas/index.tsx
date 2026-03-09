import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { buttonVariants } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Plus, Calendar } from 'lucide-react'

export const Route = createFileRoute('/schemas/')({
  component: SchemasPage,
})

function SchemasPage() {
  const schemas = useQuery(api.schemas.list)

  if (schemas === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-primary">Your Schemas</h1>
          <p className="text-muted-foreground mt-2">
            Manage your JSON schemas and create data entries
          </p>
        </div>
        <Link to="/" className={buttonVariants()}>
          <Plus className="h-4 w-4 mr-2" />
          Upload New Schema
        </Link>
      </div>

      {schemas.length === 0 ? (
        <Card className="text-center py-12">
          <CardContent className="pt-6">
            <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
              <Plus className="h-6 w-6 text-muted-foreground" />
            </div>
            <CardTitle className="mb-2">No schemas uploaded yet</CardTitle>
            <CardDescription className="mb-4">
              Get started by uploading your first JSON schema
            </CardDescription>
            <Link to="/" className={buttonVariants()}>
              Upload Your First Schema
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {schemas.map((schema) => (
            <Card key={schema._id} className="hover:shadow-md transition-shadow">
              <CardHeader>
                <CardTitle className="text-xl">{schema.title}</CardTitle>
                <CardDescription>{schema.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center text-sm text-muted-foreground mb-4">
                  <Calendar className="h-4 w-4 mr-2" />
                  Created {new Date(schema._creationTime).toLocaleDateString()}
                </div>
                <Link to="/schemas/$schemaId" params={{ schemaId: schema._id }} className={buttonVariants({ className: "w-full" })}>
                  View Details
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
