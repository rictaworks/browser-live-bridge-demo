#!/usr/bin/env bash
# test/pr7 共通ヘルパー。他スクリプトから `source` して使う。
#
# 対象は開発サーバー（ローカルのdocker compose環境、localhost固定）のみです。
# 本番サーバー（Railway/Vercel）には一切アクセスしません。

FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
RELAY_URL="${RELAY_URL:-http://localhost:3002}"
# relayコンテナが実際のdocker composeネットワーク上でbackendへ到達するのに使う
# サービス名ベースのURL（src/relay/internal/config/config.goの既定値と同じ）。
RELAY_WS_BASE="${RELAY_WS_BASE:-ws://relay:3002}"

pr7_log() {
  echo "[$(basename "$0")] $*"
}

# 指定URLがHTTP到達可能になるまで待つ。
# 引数: url, timeout_seconds(省略時180)
pr7_wait_for_http() {
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
# 使い方: pr7_json_field '{"id":1}' id
pr7_json_field() {
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

# サービスが未起動なら起動し、STARTED_SERVICES（呼び出し側で配列宣言）に追記する。
# 使い方: pr7_ensure_up backend "${BACKEND_URL}/health"
pr7_ensure_up() {
  local service="$1"
  local url="$2"
  if curl -fsS -o /dev/null "${url}" 2>/dev/null; then
    return 0
  fi
  pr7_log "${service} が未起動のため docker compose up -d --build ${service} を実行します"
  if ! docker compose up -d --build "${service}"; then
    pr7_log "FAIL: ${service} の起動に失敗しました"
    return 1
  fi
  STARTED_SERVICES+=("${service}")
  pr7_log "起動待ち: ${url}"
  pr7_wait_for_http "${url}" 180
}

# Cookieセッションで配信を1件作成し、id / broadcast_token / session_key を
# グローバル変数（PR7_BROADCAST_ID / PR7_BROADCAST_TOKEN / PR7_SESSION_KEY）に格納する。
# 使い方: pr7_create_broadcast "<cookie jarのパス>" "<title>"
pr7_create_broadcast() {
  local cookie_jar="$1"
  local title="$2"
  local body_file
  body_file="$(mktemp)"
  local code
  code="$(curl -sS -c "${cookie_jar}" -o "${body_file}" -w '%{http_code}' \
    -X POST "${BACKEND_URL}/api/broadcasts" \
    -H 'Content-Type: application/json' \
    -d "{\"layout_preset\":\"screen_primary\",\"title\":\"${title}\"}" 2>/dev/null || echo "000")"
  local body
  body="$(cat "${body_file}" 2>/dev/null || true)"
  rm -f "${body_file}"

  if [ "${code}" != "201" ]; then
    pr7_log "FAIL: POST /api/broadcasts が201を返しませんでした（実際: ${code} / body: ${body:-<空>}）"
    return 1
  fi

  PR7_BROADCAST_ID="$(pr7_json_field "${body}" id 2>/dev/null || true)"
  PR7_BROADCAST_TOKEN="$(pr7_json_field "${body}" broadcast_token 2>/dev/null || true)"
  PR7_SESSION_KEY="$(pr7_json_field "${body}" session_key 2>/dev/null || true)"

  if [ -z "${PR7_BROADCAST_ID}" ] || [ -z "${PR7_BROADCAST_TOKEN}" ] || [ -z "${PR7_SESSION_KEY}" ]; then
    pr7_log "FAIL: レスポンスからid・broadcast_token・session_keyを取得できませんでした（body: ${body:-<空>}）"
    return 1
  fi
  return 0
}
