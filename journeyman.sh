#!/usr/bin/env bash
# Everything runs in Docker. Nothing is installed on the host.
set -euo pipefail

IMAGE=journeyman:dev
NAME=journeyman
TUNNEL_NAME=journeyman-tunnel
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

  down)    docker rm -f "$NAME" >/dev/null 2>&1 && echo "server stopped" || echo "server not running"
           docker rm -f "$TUNNEL_NAME" >/dev/null 2>&1 && echo "tunnel closed" || true ;;
  logs)    docker logs -f --tail 100 "$NAME" ;;

  tunnel)  docker rm -f "$TUNNEL_NAME" >/dev/null 2>&1 || true
           # Named so cleanup never depends on signal propagation. The trap
           # covers a clean Ctrl-C; the name means `down` can still close it
           # after a killed shell or dropped SSH, when no trap ever runs.
           trap 'docker rm -f "$TUNNEL_NAME" >/dev/null 2>&1' EXIT INT TERM
           echo "Public URL for friends below."
           echo "Ctrl-C closes it, or run './journeyman.sh down' from another terminal."
           docker run --rm --name "$TUNNEL_NAME" --network host \
             cloudflare/cloudflared:latest tunnel --url http://127.0.0.1:3000 ;;

  crests)  docker run --rm -v "$DIR/public":/app/public -v "$DIR/data":/app/data:ro \
             -v "$DIR/scripts":/app/scripts:ro "$IMAGE" node scripts/fetch-crests.mjs ;;

  # Hockey: the NHL publishes this itself, so no Wikidata and no scraping.
  nhl)     docker run --rm -v "$DIR/data:/app/data" -v "$DIR/scripts:/app/scripts:ro" \
             -v "$DIR/src:/app/src:ro" "$IMAGE" node scripts/build-nhl.mjs ;;

  # Basketball: stats.nba.com, the endpoints behind nba.com. Rate limited
  # hard — expect an hour, and expect to run it twice. It resumes.
  nba)     docker run --rm -v "$DIR/data:/app/data" -v "$DIR/scripts:/app/scripts:ro" \
             -v "$DIR/src:/app/src:ro" "$IMAGE" node scripts/build-nba.mjs ;;

  nba-crests)
           docker run --rm -v "$DIR/data:/data:ro" -v "$DIR/public/crests:/out" alpine:3 sh -c '
             apk add --quiet curl jq rsvg-convert >/dev/null
             n=0
             for tri in $(jq -r "keys[]" /data/nba-logos.json); do
               url=$(jq -r --arg t "$tri" ".[\$t]" /data/nba-logos.json)
               curl -sfL --max-time 30 -A "Mozilla/5.0" -e "https://www.nba.com/" "$url" -o "/tmp/$tri.svg" \
                 || { echo "  MISS $tri"; continue; }
               rsvg-convert -w 128 -h 128 -a -f png "/tmp/$tri.svg" -o "/out/$tri.png" \
                 && n=$((n+1)) && echo "  ok   $tri" || echo "  FAIL $tri"
             done
             echo "$n logos"' ;;

  # NHL logos are SVG; the draft grid wants PNG like the football crests, so
  # they are rasterised at 128px to match. Downscaled for the same reason:
  # 32 crests load on a phone under a pick timer.
  nhl-crests)
           docker run --rm -v "$DIR/data:/data:ro" -v "$DIR/public/crests:/out" alpine:3 sh -c '
             apk add --quiet curl jq rsvg-convert >/dev/null
             n=0
             for tri in $(jq -r "keys[]" /data/nhl-logos.json); do
               url=$(jq -r --arg t "$tri" ".[\$t]" /data/nhl-logos.json)
               curl -sfL --max-time 30 "$url" -o "/tmp/$tri.svg" || { echo "  MISS $tri"; continue; }
               rsvg-convert -w 128 -h 128 -a -f png "/tmp/$tri.svg" -o "/out/$tri.png" \
                 && n=$((n+1)) && echo "  ok   $tri" || echo "  FAIL $tri"
             done
             echo "$n/32 logos"' ;;

  dataset) docker run --rm -v "$DIR/data:/app/data" -v "$DIR/scripts:/app/scripts:ro" \
             -v "$DIR/src:/app/src:ro" "$IMAGE" node scripts/build-dataset.mjs ;;

  # Second pass over dataset.json, filling career gaps from Wikipedia infoboxes.
  # Takes ~15 minutes and resumes if interrupted. Pass --dry to preview.
  enrich)  shift; docker run --rm -v "$DIR/data:/app/data" -v "$DIR/scripts:/app/scripts:ro" \
             -v "$DIR/src:/app/src:ro" "$IMAGE" node scripts/enrich-careers.mjs "$@" ;;

  *)       sed -n '2,4p' "${BASH_SOURCE[0]}"; echo
           echo "usage: ./journeyman.sh {build|test|up|down|logs|tunnel|dataset|crests|enrich|nhl|nhl-crests|nba|nba-crests}"; exit 1 ;;
esac
