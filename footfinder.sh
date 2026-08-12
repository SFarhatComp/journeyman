#!/usr/bin/env bash
# Everything runs in Docker. Nothing is installed on the host.
set -euo pipefail

IMAGE=footfinder:dev
NAME=footfinder
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-help}" in
  build)   docker build -t "$IMAGE" "$DIR" ;;

  test)    docker build -q -t "$IMAGE" "$DIR" >/dev/null
           # Glob form: `node --test test/` is broken on Node 22.23+.
           docker run --rm -v "$DIR/test:/app/test:ro" -v "$DIR/src:/app/src:ro" \
             "$IMAGE" node --test "test/*.test.js" ;;

  up)      docker rm -f "$NAME" >/dev/null 2>&1 || true
           # Publish to loopback only. Never 0.0.0.0.
           docker run -d --name "$NAME" --restart unless-stopped \
             -p 127.0.0.1:3000:3000 -e HOST=0.0.0.0 \
             --log-opt max-size=10m --log-opt max-file=3 "$IMAGE"
           echo "up on http://127.0.0.1:3000" ;;

  down)    docker rm -f "$NAME" >/dev/null 2>&1 && echo stopped || echo "not running" ;;
  logs)    docker logs -f --tail 100 "$NAME" ;;

  tunnel)  echo "Public URL for friends (Ctrl-C to close):"
           docker run --rm --network host cloudflare/cloudflared:latest \
             tunnel --url http://127.0.0.1:3000 ;;

  dataset) docker run --rm -v "$DIR/data:/app/data" -v "$DIR/scripts:/app/scripts:ro" \
             -v "$DIR/src:/app/src:ro" "$IMAGE" node scripts/build-dataset.mjs ;;

  *)       sed -n '2,4p' "${BASH_SOURCE[0]}"; echo
           echo "usage: ./footfinder.sh {build|test|up|down|logs|tunnel|dataset}"; exit 1 ;;
esac
