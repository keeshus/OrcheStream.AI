#!/usr/bin/env bash
# Stop the local dev stack: dev processes + nginx proxy + infra containers.
set -uo pipefail
cd "$(dirname "$0")/.."

pkill -f "tsx watch" >/dev/null 2>&1 || true
pkill -f "next dev" >/dev/null 2>&1 || true
docker rm -f orchestream-ai-dev-nginx >/dev/null 2>&1 || true
docker compose down --timeout 10
echo "Dev stack stopped."
