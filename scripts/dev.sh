#!/usr/bin/env bash
# One-command local dev runner: infra (Postgres/Valkey/Qdrant) + nginx proxy
# on :3000 + backend (:3001) + worker + frontend dev (:3002).
# Visit http://localhost:3000
set -euo pipefail
cd "$(dirname "$0")/.."

GATEWAY=$(docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
GATEWAY=${GATEWAY:-172.17.0.1}

echo "── Starting infrastructure (Postgres, Valkey, Qdrant) ──"
docker compose up -d postgres valkey qdrant
docker compose up -d --wait postgres valkey 2>/dev/null || true

echo "── Applying database schema ──"
set -a && source .env && set +a
npm run db:push --silent

echo "── Starting nginx proxy on :3000 ──"
sed -e "s/server backend:3001;/server ${GATEWAY}:3001;/" \
    -e "s/server frontend:3000;/server ${GATEWAY}:3002;/" \
    nginx/nginx.conf > /tmp/opencode/nginx.dev.conf
docker rm -f orchestream-ai-dev-nginx >/dev/null 2>&1 || true
docker run -d --name orchestream-ai-dev-nginx \
  -p 3000:3000 \
  -v /tmp/opencode/nginx.dev.conf:/etc/nginx/nginx.conf:ro \
  nginx:1.27-alpine >/dev/null
echo "   nginx up on http://localhost:3000"

echo "── Starting backend, worker, frontend ──"
npm run dev:services
