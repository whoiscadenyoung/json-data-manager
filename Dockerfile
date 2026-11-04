# Multi-stage build for the app server (docs/self-hosting-design.md §7).
# Builder: bun workspace install → package dists (CI's order — json-cms
# compiles against data-core/importers dists) → vite build with nitro's bun
# preset. Runtime: slim bun serving the self-contained .output.
#
# VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are publishable values (they
# ship in the client bundle by design), so they bake at build time via
# build args — docker-compose.yml feeds them from .env, CI feeds them from
# repository variables (docs/self-hosting-design.md §9).

FROM oven/bun:1.3.5 AS build
WORKDIR /repo

# Context is the repo root (.dockerignore prunes node_modules, dists,
# .output, env files, docs). bun resolves the workspace from the manifests
# + bun.lock.
COPY . .

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# The dists the app consumes through its exports; every package's dist is
# gitignored and rebuilt (ci.yml "Build workspace dists" — data-core and
# importers first: json-cms compiles against their dists).
RUN bun --filter=@caden/data-core run build && \
    bun --filter=@caden/importers run build && \
    bun --filter=@caden/json-cms run build && \
    bun --filter=@caden/geometry-archive run build

# Baked app config (see header). ENV (not just ARG) so vite's build picks
# the values up from process.env the same way a dev shell's .env.local does.
ARG VITE_SUPABASE_URL="http://localhost:8000"
ARG VITE_SUPABASE_ANON_KEY="placeholder-anon-key"
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN bun --filter=app run build

# NOTE on server runtime deps, after 2026-11-05's experiments: the output
# must ship ALONE. Bundling react into the SSR graph (ssr.noExternal) or
# shipping real node_modules beside it splits react into two instances —
# the inlined nitro copy renders, the external copy's hooks dispatcher is
# never set → "ReactSharedInternals.H" null on every route. With NOTHING
# resolvable, nitro's __require fallback serves the one inlined copy, and
# the route-tree chunk pin (vite.config.ts) keeps the static graph
# acyclic. Verified end-to-end through kong in the same session.

FROM oven/bun:1.3.5-slim AS runtime
# The nitro (bun preset) output is self-contained: server/index.mjs +
# public/ assets, no node_modules shipped.
COPY --from=build /repo/app/.output /app/.output

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "/app/.output/server/index.mjs"]
