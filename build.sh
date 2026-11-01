#!/usr/bin/env bash
# Rennko Cloud build script.
#   ./build.sh            run the whole platform locally on http://localhost:8787 (works offline)
#   ./build.sh test       syntax-check everything and run the end-to-end test against a local server
#   ./build.sh deploy     deploy to Cloudflare (sets up the SECRET the first time)
#   ./build.sh cli ...    run the rennko CLI, e.g. ./build.sh cli deploy --project demo
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund

# Local secret for signing tokens; production gets its own via wrangler secret
if [ ! -f .dev.vars ]; then
  printf 'SECRET=%s\nHOSTING_CACHE=0\n' "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" > .dev.vars
fi

case "${1:-dev}" in
  dev) PORT="${PORT:-8787}"; npx wrangler dev --port "$PORT" --local-upstream "localhost:$PORT" ;;
  test)
    echo "Syntax check"
    for f in src/*.js public/*.js cli/*.mjs test/*.mjs; do node --check "$f"; done
    echo "  ok"
    PORT="${PORT:-8799}"
    rm -rf test/.tmp && mkdir -p test/.tmp
    npx wrangler dev --port "$PORT" --local-upstream "localhost:$PORT" --var ADMIN_EMAILS:admin@test.dev --var VISIT_FLUSH_MS:0 --persist-to test/.tmp/state > test/.tmp/server.log 2>&1 &
    pid=$!
    trap 'kill $pid 2>/dev/null' EXIT
    for _ in $(seq 1 60); do curl -sf "http://localhost:$PORT/" >/dev/null && break; sleep 0.5; done
    RENNKO_URL="http://localhost:$PORT" node test/e2e.mjs
    ;;
  deploy)
    npx wrangler deploy
    if ! npx wrangler secret list 2>/dev/null | grep -q '"SECRET"'; then
      node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' | npx wrangler secret put SECRET
    fi
    ;;
  cli) shift; node cli/rennko.mjs "$@" ;;
  *) echo "usage: ./build.sh [dev|test|deploy|cli]"; exit 1 ;;
esac
