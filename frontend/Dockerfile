# ── Core Agents Frontend ─────────────────────────────────────────
# node:24-alpine (current LTS) pinned by digest — node:25 is EOL since 2026-03-31
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3 AS builder
WORKDIR /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Monorepo root config
COPY package*.json ./

# Frontend deps (needs shared too if types are referenced)
COPY shared/package*.json ./shared/
COPY shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY frontend/package*.json ./frontend/
# npm ci for reproducible builds (exact versions from package-lock.json)
RUN npm ci -w shared -w frontend && npm cache clean --force

# Build shared so the typecheck and Turbopack can resolve the compiled
# package (shared/package.json points main at ./dist/index.js)
RUN cd shared && npx -p typescript@7.0.2 tsc

# Frontend source + build
COPY frontend/tsconfig.json ./frontend/
COPY frontend/next.config.js ./frontend/
COPY frontend/postcss.config.mjs ./frontend/
COPY frontend/components.json ./frontend/
COPY frontend/src ./frontend/src/
COPY frontend/pages ./frontend/pages/
COPY frontend/public ./frontend/public/
RUN npm run build -w frontend

# ── Production image ───────────────────────────────────────
FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/frontend/.next ./frontend/.next
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/next.config.js ./frontend/
COPY --from=builder /app/frontend/package*.json ./frontend/

EXPOSE 3000
USER node
CMD ["npm", "start", "-w", "frontend", "--", "-H", "0.0.0.0"]
