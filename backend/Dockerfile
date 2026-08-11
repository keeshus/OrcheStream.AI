# ── Core Agents Backend ──────────────────────────────────────────
# node:24-alpine (current LTS) pinned by digest — node:25 is EOL since 2026-03-31
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS builder
WORKDIR /app

# Monorepo root config
COPY package*.json ./
COPY scripts/sync-version.js ./scripts/

# Shared types (needed by backend)
COPY shared/package*.json ./shared/
COPY shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/

# Worker source (needed by backend for runtime imports)
COPY worker/package*.json ./worker/
COPY worker/tsconfig.json ./worker/
COPY worker/src ./worker/src/

# Backend deps
COPY backend/package*.json ./backend/
# npm ci for reproducible builds (exact versions from package-lock.json)
RUN npm ci -w shared -w worker -w backend && npm cache clean --force

# Build shared so the compiled backend can resolve orchestream-ai-shared at runtime
# (the package main points at src/index.ts, which only tsx can load)
RUN cd shared && npx -p typescript@7.0.2 tsc && cd .. && \
    node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('shared/package.json','utf8'));p.main='./dist/index.js';p.types='./dist/index.d.ts';p.exports={'.':{types:'./dist/index.d.ts',default:'./dist/index.js'},'./types':{types:'./dist/types/index.d.ts',default:'./dist/types/index.js'},'./thinking':{types:'./dist/types/thinking.d.ts',default:'./dist/types/thinking.js'}};fs.writeFileSync('shared/package.json',JSON.stringify(p,null,2))"

# Backend source + build
COPY backend/tsconfig.build.json ./backend/tsconfig.json
COPY backend/src ./backend/src/
COPY backend/drizzle ./backend/drizzle/
# Pin tsc version to match root package-lock.json (typescript 7.0.2)
RUN cd backend && npx -p typescript@7.0.2 tsc && cd .. && npm prune --omit=dev

# ── Production image ───────────────────────────────────────
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/drizzle ./backend/drizzle
COPY --from=builder /app/backend/package*.json ./backend/

EXPOSE 3001
USER node
CMD ["node", "backend/dist/backend/src/index.js"]
