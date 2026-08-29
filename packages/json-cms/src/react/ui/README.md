# `@caden/json-cms/react/ui`

Styled, **backend-agnostic** React components for building and editing JSON
schemas and entries: the `SchemaEditor` family, an `EntryForm`, a `SchemaList`,
and the shadcn/base-ui primitives they use.

## The rule: `react/ui` never imports the backend

Everything in this directory is presentational. It must **not** import from:

- `convex` / `convex/react`
- the hooks layer (`../hooks`, `../provider`)
- the Convex client or generated code (`../../client`, `**/_generated`)

Components take **data and callbacks as props** and do no data fetching. This is
enforced by a `no-restricted-imports` ESLint rule scoped to `src/react/ui/**`.

### Why

- The schema editor, entry form, and primitives are useful with _any_ backend
  (or none). Keeping them backend-free lets non-Convex users adopt them, and
  keeps the heavy UI dependencies out of the lightweight `react` hooks entry.
- It preserves a clean seam: if these are ever split into a standalone
  `@caden/json-schema-ui` package, extraction is a file move — not a rewrite.

See [`docs/decisions/0001-backend-agnostic-react-ui.md`](../../../../../docs/decisions/0001-backend-agnostic-react-ui.md).

## Wiring to Convex (the container pattern)

Fetch with the hooks layer and pass the result down:

```tsx
import { useSchemas } from "@caden/json-cms/react";
import { SchemaList } from "@caden/json-cms/react/ui";

function Schemas({ onSelect }: { onSelect?: (id: string) => void }) {
  const schemas = useSchemas(); // undefined while loading
  return <SchemaList schemas={schemas} onSelect={onSelect} />;
}
```

`SchemaList` accepts any `{ _id, title, description }[]`, so a Convex `SchemaDoc`
is assignable directly.

## Styling

These components use Tailwind CSS v4 + shadcn CSS variables. Consumers must have
Tailwind configured and import the shipped stylesheet:

```ts
import "@caden/json-cms/react/ui/styles.css";
```
