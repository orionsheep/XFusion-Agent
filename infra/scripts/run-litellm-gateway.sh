#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_PATH="$ROOT_DIR/infra/litellm/config.yaml"

if [[ -z "${MINIMAX_API_KEY:-}" && -z "${ZHIPU_API_KEY:-}" && -z "${ZAI_API_KEY:-}" ]]; then
  echo "Either MINIMAX_API_KEY or ZHIPU_API_KEY/ZAI_API_KEY is required" >&2
  exit 1
fi

export MINIMAX_ANTHROPIC_BASE_URL="${MINIMAX_ANTHROPIC_BASE_URL:-https://api.minimaxi.com/anthropic}"
export ZAI_API_KEY="${ZAI_API_KEY:-${ZHIPU_API_KEY:-}}"
export ZAI_API_BASE="${ZAI_API_BASE:-${ZHIPU_API_BASE:-https://open.bigmodel.cn/api/paas/v4}}"

exec litellm --config "$CONFIG_PATH" --host 127.0.0.1 --port 4000
