# Initial Setup

## Tasks

### 1. Create component package from template

Use the `create-convex` CLI to create a project from the official [Convex Component Template](https://github.com/get-convex/templates/tree/main/template-component).

We are using a monorepo setup, so we will create the Convex component template in the `packages/` folder.

```zsh
bunx create-convex@latest packages/json-cms --component

# Enter your component name (e.g., "document search" or "RAG") [json-cms]: json-cms
# NPM package name (e.g. @your-org/json-cms): @caden/json-cms
# GitHub repository name (e.g. username/json-cms): whoiscadenyoung/json-data-manager
```

### 2. Start the project

```zsh
cd packages/json-cms
bun run dev

# ✔ What would you like to configure? create a new project
# ✔ Project name: json-cms
# ✔ Use cloud or local dev deployment? For more see https://docs.convex.dev/cli/local-deployments local deployment (BETA)
```

---

## Additional Resources

- [Authoring Components](https://docs.convex.dev/components/authoring): Documentation for authoring and publishing custom components.
