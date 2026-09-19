#!/usr/bin/env bash
# BIDLY — Oracle Cloud one-shot setup.
# Run on a fresh Ubuntu 22.04/24.04 ARM (aarch64) or x86 VM with sudo.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "!! docker compose plugin missing; install docker-compose-plugin" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "!! .env not found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

if [ -z "${SITE_DOMAIN:-}" ] || [ -z "${PUBLIC_API_URL:-}" ]; then
  echo "!! Set SITE_DOMAIN and PUBLIC_API_URL in .env" >&2
  exit 1
fi

# Let's Encrypt cannot issue certificates for a bare IP. If SITE_DOMAIN is an
# IP, fall back to plain HTTP so the stack still comes up.
if [[ "$SITE_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "==> SITE_DOMAIN is an IP: using HTTP (no automatic TLS)."
  echo "    For HTTPS, point a real domain at this server and re-run."
  # Idempotent: only prefix once.
  if ! head -1 Caddyfile | grep -q '^http://'; then
    sed -i 's|^{\$SITE_DOMAIN}|http://{$SITE_DOMAIN}|' Caddyfile
  fi
  if [[ "$PUBLIC_API_URL" == https://* ]]; then
    NEW="http://${PUBLIC_API_URL#https://}"
    sed -i "s|^PUBLIC_API_URL=.*|PUBLIC_API_URL=${NEW}|" .env
    sed -i "s|^CORS_ORIGINS=.*|CORS_ORIGINS=${NEW}|" .env
    sed -i "s|^API_URL=.*|API_URL=${NEW}|" .env
    sed -i "s|^APP_URL=.*|APP_URL=${NEW}|" .env
    echo "    Updated .env URLs to ${NEW}"
  fi
fi

# Re-read .env so compose/build see any value we just rewrote.
set -a; source .env; set +a

echo "==> Opening firewall (best effort; also open in Oracle Security List)"
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
sudo netfilter-persistent save 2>/dev/null || true

echo "==> Building images (first run takes several minutes)"
docker compose build

echo "==> Starting database"
docker compose up -d db

echo "==> Waiting for Postgres"
for i in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U bidly -d bidly >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> Applying migrations"
for f in $(ls ../../db/migrations/*.sql | sort); do
  echo "   - $(basename "$f")"
  docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1 < "$f"
done

echo "==> Seeding catalog (catalog only; dev users excluded)"
# The seed has a DEV-ONLY section after the line containing "DEV ONLY users".
# We keep only the catalog part so production has no fake accounts.
SEED_FILE=../../db/seed/seed.sql
CUT_AT=$(grep -n "DEV ONLY users" "$SEED_FILE" | head -1 | cut -d: -f1)
if [ -z "$CUT_AT" ]; then
  echo "!! Could not find DEV ONLY marker; refusing to seed full file" >&2
  exit 1
fi
# Cut just before the DEV section, then trim back to the last complete statement.
CATALOG=$(head -n $((CUT_AT - 1)) "$SEED_FILE" | grep -n ';' | tail -1 | cut -d: -f1)
head -n "$CATALOG" "$SEED_FILE" | docker compose exec -T db psql -U bidly -d bidly -v ON_ERROR_STOP=1

echo "==> Starting all services"
docker compose up -d

echo ""
echo "Done. Check status with:  docker compose ps"
echo "Logs:                     docker compose logs -f api"
echo "Web:  ${PUBLIC_API_URL%/*}  (via https://${SITE_DOMAIN})"
