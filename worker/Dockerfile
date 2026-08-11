# ── Core Agents Worker ───────────────────────────────────────────
# node:24-alpine (current LTS) pinned by digest — node:25 is EOL since 2026-03-31
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS builder
WORKDIR /app

# Monorepo root config
COPY package*.json ./

# Shared types (needed by worker)
COPY shared/package*.json ./shared/
COPY shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/

# Backend deps (needed by worker for runtime imports)
COPY backend/package*.json ./backend/
COPY backend/drizzle ./backend/drizzle/

# Worker deps
COPY worker/package*.json ./worker/
# npm ci for reproducible builds (exact versions from package-lock.json)
RUN npm ci -w shared -w worker -w backend --install-strategy=hoisted && npm cache clean --force

# Build shared so the compiled worker can resolve orchestream-ai-shared at runtime
# (the package main points at src/index.ts, which only tsx can load)
RUN cd shared && npx -p typescript@7.0.2 tsc && cd .. && \
    node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('shared/package.json','utf8'));p.main='./dist/index.js';p.types='./dist/index.d.ts';p.exports={'.':{types:'./dist/index.d.ts',default:'./dist/index.js'},'./types':{types:'./dist/types/index.d.ts',default:'./dist/types/index.js'},'./thinking':{types:'./dist/types/thinking.d.ts',default:'./dist/types/thinking.js'}};fs.writeFileSync('shared/package.json',JSON.stringify(p,null,2))"

# Worker source + build
COPY worker/tsconfig.build.json ./worker/tsconfig.json
COPY worker/src ./worker/src/
COPY backend/src ./backend/src/
COPY backend/tsconfig.json ./backend/
# Pin tsc version to match root package-lock.json (typescript 7.0.2)
RUN cd worker && npx -p typescript@7.0.2 tsc && cd .. && npm prune --omit=dev

# ── Production image ───────────────────────────────────────
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/worker/dist ./worker/dist
COPY --from=builder /app/worker/package*.json ./worker/

USER node
CMD ["node", "worker/dist/worker/src/run.js"]
