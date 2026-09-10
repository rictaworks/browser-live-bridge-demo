#!/usr/bin/env bash
# CORS実機確認（issue #4「Rails backendでCORSが未設定で、実ブラウザ経路では配信開始自体が
# 失敗していた問題を修正」）。
#
# src/backend/spec/requests/cors_spec.rb でRailsのrequest specレベル（Rails内部の
# テスト環境）では既に検証済みです。本スクリプトはそれと重複させず、実際に
# docker composeで起動しているbackendコンテナに対して、rack-corsミドルウェアと
# FRONTEND_ORIGIN環境変数（docker-compose.ymlで配線）が実際に効いていることを
# 生のHTTPで確認します（rspecの実行はRailsアプリ自体を経由しないため、
# 環境変数の配線ミスや、config/initializers/cors.rbがRailsに読み込まれていない
# といった配線レベルの不具合はrequest specでは検出できません）。
#
# 確認内容:
#   1. 許可オリジン（http://localhost:3000）からのpreflight（OPTIONS）に
#      Access-Control-Allow-Origin・Access-Control-Allow-Credentials: trueが返ること
#   2. 許可オリジンからの本体リクエスト（POST /api/broadcasts）にも
#      Access-Control-Allow-Originが返り、配信作成自体は成功すること
#   3. 許可外オリジンからのリクエストにはAccess-Control-Allow-Originが返らないこと
#      （ブラウザ側でレスポンスが読めずCORSエラーになる＝クロスオリジンの誤許可がないこと）
#   4. Origin未指定（同一オリジン・非ブラウザ相当）の場合は従来通り200系で動作すること
#
# 対象は開発サーバー（ローカルのdocker compose環境、localhost固定）のみです。
# 本番サーバーには一切アクセスしません。
#
# 使い方:
#   test/pr7/check_cors_real_server.sh
#
# 終了コード: 0=すべて成功 / 1=いずれか失敗

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"
# shellcheck source=./lib_common.sh
source "${SCRIPT_DIR}/lib_common.sh"

STARTED_SERVICES=()
RESULT=0

cleanup() {
  if [ "${#STARTED_SERVICES[@]}" -gt 0 ]; then
    pr7_log "自スクリプトが起動したサービスを停止します: ${STARTED_SERVICES[*]}"
    docker compose stop "${STARTED_SERVICES[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pr7_ensure_up backend "${BACKEND_URL}/health" || exit 1

ALLOWED_ORIGIN="http://localhost:3000"
DISALLOWED_ORIGIN="http://evil.example.com"

# --- 1. 許可オリジンからのpreflight ---
PREFLIGHT_HEADERS_FILE="$(mktemp)"
PREFLIGHT_CODE="$(curl -sS -D "${PREFLIGHT_HEADERS_FILE}" -o /dev/null -w '%{http_code}' \
  -X OPTIONS "${BACKEND_URL}/api/broadcasts" \
  -H "Origin: ${ALLOWED_ORIGIN}" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' 2>/dev/null || echo "000")"
PREFLIGHT_HEADERS="$(cat "${PREFLIGHT_HEADERS_FILE}" 2>/dev/null || true)"
rm -f "${PREFLIGHT_HEADERS_FILE}"

if [ "${PREFLIGHT_CODE}" != "200" ] && [ "${PREFLIGHT_CODE}" != "204" ]; then
  pr7_log "FAIL: 許可オリジンからのpreflightが200/204を返しませんでした（実際: ${PREFLIGHT_CODE}）"
  RESULT=1
elif ! grep -qi "^access-control-allow-origin: ${ALLOWED_ORIGIN}" <<<"${PREFLIGHT_HEADERS}"; then
  pr7_log "FAIL: 許可オリジンからのpreflightにAccess-Control-Allow-Originが返りませんでした"
  pr7_log "  実際のヘッダ: ${PREFLIGHT_HEADERS}"
  RESULT=1
elif ! grep -qi "^access-control-allow-credentials: true" <<<"${PREFLIGHT_HEADERS}"; then
  pr7_log "FAIL: 許可オリジンからのpreflightにAccess-Control-Allow-Credentials: trueが返りませんでした"
  RESULT=1
else
  pr7_log "PASS: 許可オリジン（${ALLOWED_ORIGIN}）からのpreflightにCORSヘッダが正しく返りました（実サーバー）"
fi

# --- 2. 許可オリジンからの本体リクエスト（実際に配信作成まで成功すること） ---
BODY_HEADERS_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
BODY_CODE="$(curl -sS -D "${BODY_HEADERS_FILE}" -o "${BODY_FILE}" -w '%{http_code}' \
  -X POST "${BACKEND_URL}/api/broadcasts" \
  -H "Origin: ${ALLOWED_ORIGIN}" \
  -H 'Content-Type: application/json' \
  -d '{"layout_preset":"screen_primary","title":"pr7 cors real server test"}' 2>/dev/null || echo "000")"
BODY_HEADERS="$(cat "${BODY_HEADERS_FILE}" 2>/dev/null || true)"
rm -f "${BODY_HEADERS_FILE}" "${BODY_FILE}"

if [ "${BODY_CODE}" != "201" ]; then
  pr7_log "FAIL: 許可オリジンからのPOST /api/broadcastsが201を返しませんでした（実際: ${BODY_CODE}）"
  RESULT=1
elif ! grep -qi "^access-control-allow-origin: ${ALLOWED_ORIGIN}" <<<"${BODY_HEADERS}"; then
  pr7_log "FAIL: 許可オリジンからの本体レスポンスにAccess-Control-Allow-Originが返りませんでした"
  RESULT=1
else
  pr7_log "PASS: 許可オリジンからの配信作成が実サーバーでCORSヘッダ付きで成功しました"
fi

# --- 3. 許可外オリジンにはAccess-Control-Allow-Originを返さないこと ---
DISALLOWED_HEADERS_FILE="$(mktemp)"
DISALLOWED_BODY_FILE="$(mktemp)"
curl -sS -D "${DISALLOWED_HEADERS_FILE}" -o "${DISALLOWED_BODY_FILE}" \
  -X POST "${BACKEND_URL}/api/broadcasts" \
  -H "Origin: ${DISALLOWED_ORIGIN}" \
  -H 'Content-Type: application/json' \
  -d '{"layout_preset":"screen_primary","title":"pr7 cors reject test"}' >/dev/null 2>&1
DISALLOWED_HEADERS="$(cat "${DISALLOWED_HEADERS_FILE}" 2>/dev/null || true)"
rm -f "${DISALLOWED_HEADERS_FILE}" "${DISALLOWED_BODY_FILE}"

if grep -qi "^access-control-allow-origin:" <<<"${DISALLOWED_HEADERS}"; then
  pr7_log "FAIL: 許可外オリジン（${DISALLOWED_ORIGIN}）にAccess-Control-Allow-Originが返ってしまいました"
  pr7_log "  実際のヘッダ: ${DISALLOWED_HEADERS}"
  RESULT=1
else
  pr7_log "PASS: 許可外オリジンにはAccess-Control-Allow-Originが返りませんでした（実サーバー）"
fi

# --- 4. Origin未指定でも従来通り動作すること（非ブラウザ経路の後方互換） ---
NO_ORIGIN_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "${BACKEND_URL}/health" 2>/dev/null || echo "000")"
if [ "${NO_ORIGIN_CODE}" != "200" ]; then
  pr7_log "FAIL: Origin未指定のGET /healthが200を返しませんでした（実際: ${NO_ORIGIN_CODE}）"
  RESULT=1
else
  pr7_log "PASS: Origin未指定のリクエストは従来通り動作しました"
fi

echo "=================================================="
if [ "${RESULT}" -eq 0 ]; then
  pr7_log "PASS: CORS実機確認はすべて成功しました"
else
  pr7_log "FAIL: CORS実機確認に失敗した項目があります"
fi

exit "${RESULT}"
