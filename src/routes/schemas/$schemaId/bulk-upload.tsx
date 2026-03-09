import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, useRef } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import validator from '@rjsf/validator-ajv8'
import { RouterButton } from '@/components/router-button'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { JsonEditor } from '@/components/ui/json-editor'
import { Label } from '@/components/ui/label'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { ArrowLeft, FileJson, Upload, X, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/schemas/$schemaId/bulk-upload')({
  component: BulkUploadPage,
})

type ValidationResult = {
  index: number
  data: unknown
  valid: boolean
  errors: string[]
}

function BulkUploadPage() {
  const { schemaId } = Route.useParams()
  const navigate = useNavigate()
  const schema = useQuery(api.schemas.get, { schemaId: schemaId as Id<'schemas'> })
  const createBulk = useMutation(api.entries.createBulk)

  const [jsonText, setJsonText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [validationResults, setValidationResults] = useState<ValidationResult[] | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const validateJson = (text: string) => {
    if (!schema) return
    setParseError(null)
    setValidationResults(null)

    if (!text.trim()) {
      setParseError('Please provide JSON input.')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setParseError('Invalid JSON — please check your input.')
      return
    }

    if (!Array.isArray(parsed)) {
      setParseError('Input must be a JSON array of objects.')
      return
    }

    if (parsed.length === 0) {
      setParseError('Array is empty — no entries to upload.')
      return
    }

    const results: ValidationResult[] = parsed.map((item, index) => {
      const { errors } = validator.validateFormData(item, schema.schema)
      return {
        index,
        data: item,
        valid: errors.length === 0,
        errors: errors.map((e) => e.stack ?? e.message ?? String(e)),
      }
    })

    setValidationResults(results)
  }

  const loadFile = (file: File) => {
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      toast.error('Please upload a .json file.')
      return
    }
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = (event.target?.result as string) ?? ''
      setJsonText(text)
      validateJson(text)
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
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }

  const clearInput = () => {
    setJsonText('')
    setFileName(null)
    setParseError(null)
    setValidationResults(null)
  }

  const handleSubmit = async () => {
    if (!validationResults) return
    const validEntries = validationResults.filter((r) => r.valid).map((r) => r.data)
    if (validEntries.length === 0) {
      toast.error('No valid entries to upload.')
      return
    }

    setIsSubmitting(true)
    try {
      await createBulk({
        schemaId: schemaId as Id<'schemas'>,
        dataArray: validEntries,
      })
      toast.success(`${validEntries.length} ${validEntries.length === 1 ? 'entry' : 'entries'} uploaded!`)
      navigate({ to: '/schemas/$schemaId', params: { schemaId } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to upload entries.')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (schema === undefined) {
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

  const validCount = validationResults?.filter((r) => r.valid).length ?? 0
  const invalidCount = validationResults?.filter((r) => !r.valid).length ?? 0

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
              <BreadcrumbPage>Bulk Upload</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-4">
          <RouterButton variant="ghost" size="sm" to="/schemas/$schemaId" params={{ schemaId }} className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </RouterButton>
          <div>
            <h1 className="text-3xl font-bold text-primary">Bulk Upload</h1>
            <p className="text-muted-foreground mt-1">
              Upload a JSON array of objects to create multiple entries at once.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>JSON Input</CardTitle>
            <CardDescription>
              Upload a <code>.json</code> file or paste a JSON array below. Each object will be validated against the <strong>{schema.title}</strong> schema.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                  'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-6 text-center transition-colors cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isDragging
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-muted/50',
                ].join(' ')}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) =>
                  e.key === 'Enter' || e.key === ' ' ? fileInputRef.current?.click() : undefined
                }
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <FileJson className={`h-7 w-7 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
                {fileName ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{fileName}</span>
                    <button
                      type="button"
                      aria-label="Remove file"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        clearInput()
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

            <div className="space-y-2">
              <Label id="json-paste-label">Paste JSON Array</Label>
              <JsonEditor
                value={jsonText}
                onChange={(value) => {
                  setJsonText(value)
                  if (fileName) setFileName(null)
                  setParseError(null)
                  setValidationResults(null)
                }}
                placeholder={'[\n  { "field": "value" },\n  { "field": "value" }\n]'}
                aria-labelledby="json-paste-label"
              />
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={() => validateJson(jsonText)}
              disabled={!jsonText.trim()}
            >
              Validate Entries
            </Button>
          </CardContent>
        </Card>

        {/* Parse error */}
        {parseError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
            {parseError}
          </div>
        )}

        {/* Validation results summary */}
        {validationResults && (
          <Card>
            <CardHeader>
              <CardTitle>Validation Results</CardTitle>
              <CardDescription>
                {validCount} valid, {invalidCount} invalid out of {validationResults.length} entries
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Summary banner */}
              {invalidCount === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950 px-4 py-3 text-sm text-green-800 dark:text-green-200">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  All {validCount} entries are valid and ready to upload.
                </div>
              ) : validCount > 0 ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  {invalidCount} {invalidCount === 1 ? 'entry has' : 'entries have'} validation errors. Only the {validCount} valid {validCount === 1 ? 'entry' : 'entries'} will be uploaded.
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  <XCircle className="h-4 w-4 shrink-0" />
                  All entries have validation errors. Please fix them before uploading.
                </div>
              )}

              {/* Per-entry errors */}
              {invalidCount > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {validationResults
                    .filter((r) => !r.valid)
                    .map((r) => (
                      <div key={r.index} className="rounded-md border border-destructive/20 bg-muted/50 p-3 text-sm">
                        <p className="font-medium text-foreground mb-1">Entry {r.index + 1}</p>
                        <ul className="space-y-0.5 text-destructive">
                          {r.errors.map((e, i) => (
                            <li key={i} className="text-xs">{e}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
              )}

              <Button
                onClick={handleSubmit}
                disabled={isSubmitting || validCount === 0}
              >
                <Upload className="h-4 w-4 mr-2" />
                {isSubmitting
                  ? 'Uploading…'
                  : `Upload ${validCount} Valid ${validCount === 1 ? 'Entry' : 'Entries'}`}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
