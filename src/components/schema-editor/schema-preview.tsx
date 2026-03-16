import { useState, useMemo } from "react";
import Form from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";
import { Eye, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "#/components/ui/card";
import { cn } from "#/lib/utils";

interface SchemaPreviewProps {
  schemaJson: string;
}

export function SchemaPreview({ schemaJson }: SchemaPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [formData, setFormData] = useState<unknown>({});

  const { schema, error } = useMemo(() => {
    if (!schemaJson.trim()) {
      return { schema: null, error: "Schema is empty" };
    }
    try {
      const parsed = JSON.parse(schemaJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { schema: null, error: "Schema must be a JSON object" };
      }
      // Basic validation: check for required fields
      if (!parsed.title || typeof parsed.title !== "string") {
        return { schema: null, error: "Schema must have a 'title' property" };
      }
      return { schema: parsed, error: null };
    } catch {
      return { schema: null, error: "Invalid JSON" };
    }
  }, [schemaJson]);

  // Collapsed state - show a compact card
  if (!isExpanded) {
    return (
      <Card className="mt-4">
        <button
          type="button"
          onClick={() => setIsExpanded(true)}
          className="w-full text-left"
        >
          <CardHeader className="py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-sm">Form Preview</CardTitle>
              </div>
              <span className="text-xs text-muted-foreground">Click to expand</span>
            </div>
            <CardDescription className="text-xs">
              Preview how the form will look when creating entries with this schema
            </CardDescription>
          </CardHeader>
        </button>
      </Card>
    );
  }

  // Expanded state - show the form
  return (
    <Card className="mt-4">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">Form Preview</CardTitle>
          </div>
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Collapse
          </button>
        </div>
        <CardDescription className="text-xs">
          Live preview of how the form will appear when creating entries
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Cannot preview form</p>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">{error}</p>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "rounded-lg border border-border p-4",
              "[&_.rjsf]:space-y-4",
              "[&_.field]:space-y-1.5",
              "[&_label]:text-xs [&_label]:font-medium",
              "[&_input]:h-8 [&_input]:text-xs [&_input]:rounded-md [&_input]:border [&_input]:border-input [&_input]:px-2.5",
              "[&_input]:focus-visible:outline-none [&_input]:focus-visible:ring-1 [&_input]:focus-visible:ring-ring",
              "[&_select]:h-8 [&_select]:text-xs [&_select]:rounded-md [&_select]:border [&_select]:border-input [&_select]:px-2.5",
              "[&_select]:focus-visible:outline-none [&_select]:focus-visible:ring-1 [&_select]:focus-visible:ring-ring",
              "[&_textarea]:text-xs [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-input [&_textarea]:p-2.5",
              "[&_textarea]:focus-visible:outline-none [&_textarea]:focus-visible:ring-1 [&_textarea]:focus-visible:ring-ring",
              "[&_.checkbox]:h-4 [&_.checkbox]:w-4",
              "[&_button[type='submit']]:h-9 [&_button[type='submit']]:px-4 [&_button[type='submit']]:rounded-md",
              "[&_button[type='submit']]:bg-primary [&_button[type='submit']]:text-primary-foreground",
              "[&_button[type='submit']]:text-xs [&_button[type='submit']]:font-medium",
              "[&_button[type='submit']]:hover:bg-primary/90",
              "[&_.panel]:rounded-md [&_.panel]:border [&_.panel]:border-border [&_.panel]:p-3 [&_.panel]:space-y-3",
              "[&_.array-item]:rounded-md [&_.array-item]:border [&_.array-item]:border-border [&_.array-item]:p-3 [&_.array-item]:mb-2",
              "[&_.array-item-toolbar]:flex [&_.array-item-toolbar]:justify-end [&_.array-item-toolbar]:gap-1 [&_.array-item-toolbar]:mb-2",
              "[&_.array-item-toolbar_button]:h-6 [&_.array-item-toolbar_button]:w-6 [&_.array-item-toolbar_button]:p-0",
              "[&_.array-item-add_button]:h-8 [&_.array-item-add_button]:px-3 [&_.array-item-add_button]:text-xs",
              "[&_.array-item-add_button]:border [&_.array-item-add_button]:border-dashed [&_.array-item-add_button]:border-border",
              "[&_.error-detail]:text-xs [&_.error-detail]:text-destructive",
            )}
          >
            <Form
              schema={schema!}
              validator={validator}
              formData={formData}
              onChange={(data) => setFormData(data.formData)}
              onSubmit={(data) => console.log("Preview form submitted:", data.formData)}
              uiSchema={{
                "ui:submitButtonOptions": {
                  submitText: "Create Entry (Preview)",
                  norender: false,
                  props: {
                    disabled: true,
                    className: "w-full opacity-50 cursor-not-allowed",
                  },
                },
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
