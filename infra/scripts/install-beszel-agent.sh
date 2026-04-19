#!/usr/bin/env bash
set -euo pipefail

KEY="${KEY:-}"
TOKEN="${TOKEN:-}"
HUB_URL="${HUB_URL:-}"
LISTEN="${LISTEN:-45876}"

if [[ -z "$KEY" || -z "$TOKEN" || -z "$HUB_URL" ]]; then
  echo "Usage: KEY='<public-key>' TOKEN='<token>' HUB_URL='http://<hub-host>:8090' bash infra/scripts/install-beszel-agent.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for this installer."
  exit 1
fi

docker rm -f beszel-agent >/dev/null 2>&1 || true
docker run -d \
  --name beszel-agent \
  --network host \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e KEY="$KEY" \
  -e TOKEN="$TOKEN" \
  -e HUB_URL="$HUB_URL" \
  -e LISTEN="$LISTEN" \
  henrygd/beszel-agent:latest

echo "Beszel Agent installed and started."
