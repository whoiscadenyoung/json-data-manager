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

# NOTE on server runtime deps (rewritten for #243): the output ships ALONE
# except for the react-family runtime packages that
# app/scripts/finalize-ssr-output.ts materializes INSIDE
# .output/server/node_modules (react/react-dom/scheduler — they come with the
# .output copy below). react stays EXTERNAL through the whole SSR pipeline
# (app/vite.config.ts) so a process has exactly one react instance, and both
# of rolldown's interop flavors for an external react — an ESM import or a
# bare `__require` createRequire shim, chosen per platform build — resolve
# against those real packages. The earlier arrangement (react bundled into a
# nitro `_libs` chunk, no node_modules at all) silently depended on the
# linux build's codegen flavor: the copy disappeared and every route served
# ResolveMessage JSON (#243). The finalize script now fails the build when
# the output isn't self-contained.

FROM oven/bun:1.3.5-slim AS runtime
# The nitro (bun preset) output is self-contained: server/index.mjs +
# public/ assets, no node_modules shipped.
COPY --from=build /repo/app/.output /app/.output

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "/app/.output/server/index.mjs"]
