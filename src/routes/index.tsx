import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { Button } from '#/components/ui/button'
import { RouterButton } from '#/components/router-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Textarea } from '#/components/ui/textarea'
import { Label } from '#/components/ui/label'
import { Upload, Calendar } from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const schemas = useQuery(api.schemas.list)
  const createSchema = useMutation(api.schemas.create)
  const [json, setJson] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      toast.error('Invalid JSON — please check your input.')
      return
    }

    setIsSubmitting(true)
    try {
      await createSchema({ schema: parsed })
      toast.success('Schema uploaded!')
      setJson('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to upload schema.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <Card className="mb-10">
        <CardHeader>
          <CardTitle>Upload a Schema</CardTitle>
          <CardDescription>
            Paste a JSON Schema below. It must include <code>title</code> and{' '}
            <code>description</code> fields.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUpload} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="schema-json">JSON Schema</Label>
              <Textarea
                id="schema-json"
                placeholder={'{\n  "title": "My Schema",\n  "description": "...",\n  "type": "object",\n  "properties": {}\n}'}
                className="min-h-48 font-mono text-sm"
                value={json}
                onChange={(e) => setJson(e.target.value)}
                required
              />
            </div>
            <Button type="submit" disabled={isSubmitting}>
              <Upload className="h-4 w-4 mr-2" />
              {isSubmitting ? 'Uploading…' : 'Upload Schema'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <section>
        <h2 className="text-xl font-semibold mb-4">Your Schemas</h2>
        {schemas === undefined ? (
          <div className="flex justify-center items-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : schemas.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No schemas yet — upload one above to get started.
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
      </section>
    </main>
  )
}
