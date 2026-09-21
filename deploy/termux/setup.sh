#!/data/data/com.termux/files/usr/bin/bash
# =====================================================================
#  BIDLY API — run on your Android phone with Termux
#  Downloads a prebuilt API bundle from GitHub, unpacks it, and starts
#  the server connected to your Supabase database.
#
#  One-time setup. After this, start the API with:  bash ~/bidly-api/run.sh
#
#  To pick up new API features later:
#      bash setup.sh --update
#  --update re-downloads the current bundle (never a cached copy) and
#  keeps your .env, so you don't re-enter the database password.
# =====================================================================
set -e

REPO="staryounix1/BIDLY"
REF="main"
PARTS=62
# Bump this whenever a new bundle is published. It is appended to every part
# URL as a cache-buster so neither GitHub's raw CDN nor any intermediate cache
# can hand back a stale part under the same filename.
BUNDLE_VERSION="2026-09-21-2"
DIR="$HOME/bidly-api"
PARTS_DIR="$DIR/parts"

echo ""
echo "======================================================"
echo "  BIDLY API setup for Termux  (bundle $BUNDLE_VERSION)"
echo "======================================================"

UPDATE=0
if [ "$1" = "--update" ]; then
  UPDATE=1
  echo "Updating an existing install (your .env is preserved)."
  if [ -d "$DIR" ]; then
    mv "$DIR/.env" "$DIR/.env.keep" 2>/dev/null || true
  fi
  # Always drop the old build AND the part cache. The cache is the reason a
  # previous --update could appear to succeed while running the old API: the
  # download loop skips any part file that already exists, so leave them in
  # place and you unpack the previous bundle over and over.
  rm -rf "$DIR/dist" "$DIR/node_modules" "$PARTS_DIR"
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed yet. Run this first:"
  echo "    pkg update -y && pkg install -y nodejs-lts"
  echo "then run this script again."
  exit 1
fi
echo "Node: $(node --version)"

# curl and tar ship with the base Termux image, but a trimmed install (or a
# Termux that was just cleared) may lack them, and the failure would otherwise
# surface later as a confusing "command not found" mid-download.
missing=""
command -v curl >/dev/null 2>&1 || missing="$missing curl"
command -v tar  >/dev/null 2>&1 || missing="$missing tar"
command -v base64 >/dev/null 2>&1 || missing="$missing base64"
if [ -n "$missing" ]; then
  echo ""
  echo "Missing required tools:$missing"
  echo "Install them first:  pkg install -y$missing"
  exit 1
fi

# A directory left behind without a dist/ (an interrupted earlier run) would
# make --update skip the download yet still have nothing to start, so treat it
# as a fresh install and fetch the bundle.
if [ "$UPDATE" = "1" ] && [ -d "$DIR" ] && [ ! -f "$DIR/dist/server.js" ]; then
  echo "Found an incomplete install; downloading the full bundle."
fi

mkdir -p "$PARTS_DIR"
cd "$DIR"

echo ""
echo "==> Downloading API bundle"
i=0
while [ "$i" -lt "$PARTS" ]; do
  num=$(printf "%03d" "$i")
  out="$PARTS_DIR/c$num.bin"
  if [ ! -s "$out" ]; then
    url="https://raw.githubusercontent.com/${REPO}/${REF}/bundle2/c${num}.bin?v=${BUNDLE_VERSION}"
    curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url" \
      || { echo ""; echo "Failed to download part $num. Check your connection and run this again."; exit 1; }
  fi
  printf "\r  part %s/%s" "$((i+1))" "$PARTS"
  i=$((i+1))
done
echo ""
echo "==> Downloaded"

echo "==> Unpacking"
# The parts are base64 text; decode before extracting. Joining them in shell
# order (c000, c001, ...) reconstructs the original archive byte for byte.
cat "$PARTS_DIR"/c*.bin > bundle.b64
base64 -d bundle.b64 > bundle.tar.gz
rm -rf "$PARTS_DIR" bundle.b64
# The archive contains no hard links (they are unsupported on Android storage),
# so a plain extraction works. --no-same-owner avoids chown failures.
tar xzf bundle.tar.gz --no-same-owner --no-same-permissions 2>/dev/null \
  || tar xzf bundle.tar.gz --no-same-owner
rm -f bundle.tar.gz
if [ ! -f "$DIR/dist/server.js" ]; then
  echo "!! Extraction failed: dist/server.js is missing."
  exit 1
fi
if [ ! -d "$DIR/node_modules/fastify" ]; then
  echo "!! Extraction incomplete: node_modules/fastify is missing."
  exit 1
fi
echo "==> Installed to $DIR"

# --- start script -----------------------------------------------------
cat > "$DIR/run.sh" <<'RUNEOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set. Edit ~/bidly-api/.env first."
  exit 1
fi
echo "Starting BIDLY API on port ${API_PORT:-4000} ..."
exec node dist/server.js
RUNEOF
chmod +x "$DIR/run.sh"

if [ -f "$DIR/.env.keep" ]; then
  mv "$DIR/.env.keep" "$DIR/.env"
fi

if [ ! -f "$DIR/.env" ]; then
  cat > "$DIR/.env" <<'ENVEOF'
# BIDLY API — Termux config.
# Replace the DATABASE_URL value with your Supabase connection string
# (Supabase -> Project Settings -> Database -> Connection string -> URI).
DATABASE_URL=postgresql://postgres.irtxdculyyiwxovurstp:BidlyLive2026xyzAB@aws-0-us-east-1.pooler.supabase.com:5432/postgres
DATABASE_SSL=true
API_PORT=4000
NODE_ENV=development
STORAGE_DRIVER=local
PAYMENT_PROVIDER=internal
PAYMENT_SANDBOX=true
PAYMENT_WEBHOOK_SECRET=local-dev-webhook-secret-000000000000000000
AUTH_SECRET=local-dev-auth-secret-0000000000000000000000000000
REFRESH_SECRET=local-dev-refresh-secret-000000000000000000000000
CORS_ORIGINS=https://bidly-mauve.vercel.app
APP_URL=https://bidly-mauve.vercel.app
API_URL=https://bidly-mauve.vercel.app
EMAIL_PROVIDER=log
SMS_PROVIDER=log
PUSH_PROVIDER=webpush
VAPID_PUBLIC_KEY=BGZZqyiX6br5gtvMS98AL8pEzI9Zu9qERi7LOinTAat_lJ00PAgqgASexTd6eUJVDkg1F33MeygHFkbZtHI08p8
VAPID_PRIVATE_KEY=vtwBeP4XbaHXc9GxsMJK1lTtwEg26XZnB7gV9gVA_Hk
VAPID_SUBJECT=mailto:support@bidly.app
DEMO_MODE=false
LOG_LEVEL=info
LOG_PRETTY=false
RATE_LIMIT_ENABLED=false
DEFAULT_CURRENCY=MAD
DEFAULT_COUNTRY=MA
DEFAULT_LOCALE=ar
SUPPORTED_LOCALES=ar,fr,en
ENVEOF
  echo ""
  echo "======================================================"
  echo "  Ready. Start the API with:"
  echo ""
  echo "      bash ~/bidly-api/run.sh"
  echo ""
  echo "  The .env is pre-filled. If your database password"
  echo "  differs, edit ~/bidly-api/.env first."
  echo "======================================================"
else
  echo ""
  echo "Updated to bundle $BUNDLE_VERSION."
  echo "Start the API with:  bash ~/bidly-api/run.sh"
fi
