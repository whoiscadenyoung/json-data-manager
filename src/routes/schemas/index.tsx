import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { RouterButton } from '#/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Calendar } from 'lucide-react'

export const Route = createFileRoute('/schemas/')({
  component: SchemasPage,
})

function SchemasPage() {
  const schemas = useQuery(api.schemas.list)

  if (schemas === undefined) {
    return (
      <div className="flex justify-center items-center min-h-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-3xl font-bold text-primary mb-1">Your Schemas</h1>
      <p className="text-muted-foreground mb-8">
        Manage your JSON schemas and create data entries
      </p>

      {schemas.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No schemas yet —{' '}
          <RouterButton variant="link" to="/" className="p-0 h-auto">
            upload one
          </RouterButton>{' '}
          to get started.
        </p>
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
                <RouterButton className="w-full" to="/schemas/$schemaId" params={{ schemaId: schema._id }}>
                  View Details
                </RouterButton>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  )
}
