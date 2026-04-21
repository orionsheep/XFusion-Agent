#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_PATH="$ROOT_DIR/infra/litellm/config.yaml"

if [[ -z "${MINIMAX_API_KEY:-}" ]]; then
  echo "MINIMAX_API_KEY is required" >&2
  exit 1
fi

export MINIMAX_ANTHROPIC_BASE_URL="${MINIMAX_ANTHROPIC_BASE_URL:-https://api.minimaxi.com/anthropic}"

exec litellm --config "$CONFIG_PATH" --host 127.0.0.1 --port 4000
