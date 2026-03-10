import { cn } from "#/lib/utils";

interface JsonTreeProps {
  data: unknown;
  /** Set of AJV instancePaths that are failing, e.g. "/email", "/address/city" */
  failingPaths: Set<string>;
  /** Map of AJV instancePath → human-readable error message */
  errors: Map<string, string>;
  path?: string;
  depth?: number;
}

function formatPrimitive(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

function primitiveColor(value: unknown): string {
  if (value === null) return "text-muted-foreground";
  if (typeof value === "boolean") return "text-blue-600 dark:text-blue-400";
  if (typeof value === "number") return "text-emerald-600 dark:text-emerald-400";
  return "text-amber-600 dark:text-amber-400";
}

export function JsonTree({ data, failingPaths, errors, path = "", depth = 0 }: JsonTreeProps) {
  const indent = depth * 12;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-muted-foreground text-xs">[]</span>;
    return (
      <div>
        {data.map((item, i) => {
          const itemPath = `${path}/${i}`;
          return (
            <div key={i} style={{ marginLeft: indent > 0 ? 0 : undefined }}>
              <span className="text-muted-foreground text-xs mr-1">{i}:</span>
              <JsonTree
                data={item}
                failingPaths={failingPaths}
                errors={errors}
                path={itemPath}
                depth={depth + 1}
              />
            </div>
          );
        })}
      </div>
    );
  }

  if (typeof data === "object" && data !== null) {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground text-xs">{"{}"}</span>;
    return (
      <div className="space-y-0.5">
        {entries.map(([key, value]) => {
          const keyPath = `${path}/${key}`;
          const isFailing = failingPaths.has(keyPath);
          const errorMsg = errors.get(keyPath);

          return (
            <div key={key} style={{ marginLeft: depth * 12 }}>
              <div
                className={cn(
                  "flex items-start gap-1 rounded px-1 py-0.5 text-xs font-mono",
                  isFailing && "bg-destructive/10",
                )}
              >
                <span
                  className={cn(
                    "font-medium shrink-0",
                    isFailing ? "text-destructive" : "text-foreground",
                  )}
                >
                  {key}:
                </span>
                {typeof value === "object" && value !== null ? (
                  <div className="min-w-0">
                    <JsonTree
                      data={value}
                      failingPaths={failingPaths}
                      errors={errors}
                      path={keyPath}
                      depth={depth + 1}
                    />
                  </div>
                ) : (
                  <span className={cn(primitiveColor(value), "truncate")}>
                    {formatPrimitive(value)}
                  </span>
                )}
              </div>
              {isFailing && errorMsg && (
                <div
                  style={{ marginLeft: depth * 12 + 4 }}
                  className="text-[10px] text-destructive px-1 pb-0.5 leading-tight"
                >
                  {errorMsg}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Primitive at root level
  return (
    <span className={cn("text-xs font-mono", primitiveColor(data))}>{formatPrimitive(data)}</span>
  );
}
