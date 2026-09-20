#!/data/data/com.termux/files/usr/bin/bash
# =====================================================================
#  BIDLY API — run on your Android phone with Termux
#  Downloads a prebuilt API bundle from GitHub, unpacks it, and starts
#  the server connected to your Supabase database.
#
#  One-time setup. After this, start the API with:  bash ~/bidly-api/run.sh
# =====================================================================
set -e

REPO="staryounix1/BIDLY"
REF="main"
PARTS=61
DIR="$HOME/bidly-api"
PARTS_DIR="$DIR/parts"

echo ""
echo "======================================================"
echo "  BIDLY API setup for Termux"
echo "======================================================"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js is not installed yet. Run this first:"
  echo "    pkg update -y && pkg install -y nodejs-lts"
  echo "then run this script again."
  exit 1
fi
echo "Node: $(node --version)"

mkdir -p "$PARTS_DIR"
cd "$DIR"

echo ""
echo "==> Downloading API bundle (~3.5 MB)"
i=0
while [ "$i" -lt "$PARTS" ]; do
  num=$(printf "%03d" "$i")
  out="$PARTS_DIR/c$num.bin"
  if [ ! -s "$out" ]; then
    url="https://raw.githubusercontent.com/${REPO}/${REF}/bundle/c${num}.b64"
    curl -fsSL -o "$out" "$url" || { echo "Failed to download part $num"; exit 1; }
  fi
  printf "\r  part %s/%s" "$((i+1))" "$PARTS"
  i=$((i+1))
done
echo ""
echo "==> Downloaded"

echo "==> Unpacking"
cat "$PARTS_DIR"/c*.bin > bundle.tar.gz
# Android storage does not support hard links, which pnpm's store uses.
# --hard-dereference turns every hard link into a normal file so the
# extraction succeeds on Termux.
tar xzf bundle.tar.gz --hard-dereference --no-same-owner --no-same-permissions 2>/dev/null \
  || tar xzf bundle.tar.gz --hard-dereference --no-same-owner
rm -rf "$PARTS_DIR" bundle.tar.gz
if [ ! -f "$DIR/dist/server.js" ]; then
  echo "!! Extraction failed: dist/server.js is missing."
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
  echo "Start the API with:  bash ~/bidly-api/run.sh"
fi
