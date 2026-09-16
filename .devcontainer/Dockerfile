# Dev container for json-data-manager (bun workspace + Convex local backend).
# Works with any Docker-API engine: Docker Desktop, OrbStack, or (experimentally)
# Apple's `container` runtime — see docs/dev-environment.md.
FROM oven/bun:1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*
