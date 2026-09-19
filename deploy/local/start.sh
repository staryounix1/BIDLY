#!/usr/bin/env bash
# BIDLY — run everything locally with one command (macOS / Linux).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed."
  echo "Install Docker Desktop first: https://www.docker.com/products/docker-desktop/"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Open Docker Desktop and try again."
  exit 1
fi

cp -n env.local .env

echo "==> Building images (this can take a few minutes the first time)"
docker compose build

echo "==> Starting database"
docker compose up -d db
echo "==> Waiting for database"
for i in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U bidly -d bidly >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> Applying migrations"
for f in $(ls ../../db/migrations/*.sql | sort); do
  docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1 -q < "$f"
done

echo "==> Seeding data"
docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1 -q < ../../db/seed/seed.sql

echo "==> Setting demo account passwords"
docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1 -q < fix-passwords.sql

echo "==> Starting API and web"
docker compose up -d api web

echo ""
echo "===================================================="
echo "  BIDLY is running:"
echo "  Website :  http://localhost:3000"
echo "  API     :  http://localhost:4000"
echo "  Health  :  http://localhost:4000/health"
echo ""
echo "  Demo accounts (password: BidlyDev!2026)"
echo "    customer@bidly.test"
echo "    provider@bidly.test"
echo ""
echo "  Stop everything:   docker compose down"
echo "  View API logs:     docker compose logs -f api"
echo "===================================================="
