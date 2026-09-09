#!/usr/bin/env bash
# test/pr6 共通ヘルパー。他スクリプトから `source` して使う。
#
# 対象は開発サーバー（ローカルのdocker compose環境、localhost固定）のみです。
# 本番サーバー（Railway/Vercel）には一切アクセスしません。

FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
RELAY_URL="${RELAY_URL:-http://localhost:3002}"

pr6_log() {
  echo "[$(basename "$0")] $*"
}

# 指定URLがHTTP到達可能になるまで待つ。
# 引数: url, timeout_seconds(省略時180)
pr6_wait_for_http() {
  local url="$1"
  local timeout="${2:-180}"
  local waited=0
  local interval=3
  while [ "${waited}" -lt "${timeout}" ]; do
    if curl -fsS -o /dev/null "${url}" 2>/dev/null; then
      return 0
    fi
    sleep "${interval}"
    waited=$((waited + interval))
  done
  return 1
}

# JSON文字列から指定フィールドを取り出す（python3依存、jq不使用）。
# 使い方: pr6_json_field '{"id":1}' id
pr6_json_field() {
  local json="$1"
  local field="$2"
  python3 -c '
import json, sys
try:
    data = json.loads(sys.argv[1])
except ValueError:
    sys.exit(1)
value = data.get(sys.argv[2])
if value is None:
    sys.exit(1)
print(value)
' "${json}" "${field}"
}
