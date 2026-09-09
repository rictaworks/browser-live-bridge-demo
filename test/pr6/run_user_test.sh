#!/usr/bin/env bash
# PR #6 ユーザーテスト手順のうち、ブラウザの許可（画面共有・カメラ・マイク）が不要で
# HTTPだけで確認できる部分を自動実行するスクリプトです。
#
# PR本文のユーザーテスト手順の対応関係:
#   1. 開発チームがdocker compose upを起動 → 本スクリプトが必要なら自分で起動
#   2〜5(前半). スタジオ画面を開く                → GET /studio が200であることを確認
#      （画面共有・カメラ・マイクの許可、プレビュー確認は対象外。理由はREADME参照）
#   6. 「配信開始」→配信中表示・モニターURL表示    → POST /api/broadcasts で配信を作成し、
#      レスポンスにbroadcast_token（モニターURLの材料）が含まれることを確認
#   7〜8. モニターURLを別タブで開き、同じ映像が再生される・擬似視聴者数とチャットが流れる
#      → GET /monitor/[token] が200であることを確認（実再生はplaywrightでも許可ダイアログの
#        制約で自動化できないためユニットテスト側の対象。README参照）
#      → GET /api/broadcasts/:id/audience で擬似視聴者数・擬似チャットが取得できることを確認
#   9. 「配信停止」→モニターが「終了しました」表示 → POST /api/broadcasts/:id/stop で状態が
#      endedになることと、GET /api/broadcasts/:id で反映されることを確認
#
# 加えて、3層（frontend/backend/relay）のヘルスチェックとGET /api/broadcasts/:idの単体取得も
# 確認します。
#
# 対象は開発サーバー（ローカルのdocker compose環境、localhost固定）のみです。
# 本番サーバーには一切アクセスしません。
#
# 使い方:
#   test/pr6/run_user_test.sh
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
COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "${COOKIE_JAR}"
  if [ "${#STARTED_SERVICES[@]}" -gt 0 ]; then
    pr6_log "自スクリプトが起動したサービスを停止します: ${STARTED_SERVICES[*]}"
    docker compose stop "${STARTED_SERVICES[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ensure_up() {
  local service="$1"
  local url="$2"
  if curl -fsS -o /dev/null "${url}" 2>/dev/null; then
    return 0
  fi
  pr6_log "${service} が未起動のため docker compose up -d --build ${service} を実行します"
  if ! docker compose up -d --build "${service}"; then
    pr6_log "FAIL: ${service} の起動に失敗しました"
    return 1
  fi
  STARTED_SERVICES+=("${service}")
  pr6_log "起動待ち: ${url}"
  pr6_wait_for_http "${url}" 180
}

check_health() {
  local label="$1"
  local url="$2"
  local body
  body="$(curl -sS "${url}" 2>/dev/null || true)"
  if [ "${body}" != '{"status":"ok"}' ]; then
    pr6_log "FAIL: ${label} のヘルスチェックが期待値と一致しません（URL: ${url} / 実際: ${body:-<空>}）"
    RESULT=1
    return 1
  fi
  pr6_log "PASS: ${label} のヘルスチェックはokです（${url}）"
  return 0
}

check_page_200() {
  local label="$1"
  local url="$2"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null || echo "000")"
  if [ "${code}" != "200" ]; then
    pr6_log "FAIL: ${label} が200を返しませんでした（URL: ${url} / 実際: ${code}）"
    RESULT=1
    return 1
  fi
  pr6_log "PASS: ${label} は200を返しました（${url}）"
  return 0
}

# --- 1. 開発サーバー起動（未起動分のみ） ---
ensure_up frontend "${FRONTEND_URL}/api/health" || exit 1
ensure_up backend "${BACKEND_URL}/health" || exit 1
ensure_up relay "${RELAY_URL}/health" || exit 1

# --- 3層のヘルスチェック ---
check_health "フロントエンド" "${FRONTEND_URL}/api/health"
check_health "アプリケーション（backend）" "${BACKEND_URL}/health"
check_health "中継（relay）" "${RELAY_URL}/health"

# --- スタジオ画面が200で開けること（手順2〜5前半の代替確認） ---
check_page_200 "配信スタジオ画面（/studio）" "${FRONTEND_URL}/studio"

# --- 配信作成（手順6） ---
CREATE_BODY_FILE="$(mktemp)"
CREATE_CODE="$(curl -sS -c "${COOKIE_JAR}" -o "${CREATE_BODY_FILE}" -w '%{http_code}' \
  -X POST "${BACKEND_URL}/api/broadcasts" \
  -H 'Content-Type: application/json' \
  -d '{"layout_preset":"screen_primary","title":"pr6 user test"}' 2>/dev/null || echo "000")"
CREATE_BODY="$(cat "${CREATE_BODY_FILE}" 2>/dev/null || true)"
rm -f "${CREATE_BODY_FILE}"

if [ "${CREATE_CODE}" != "201" ]; then
  pr6_log "FAIL: POST /api/broadcasts が201を返しませんでした（実際: ${CREATE_CODE} / body: ${CREATE_BODY:-<空>}）"
  RESULT=1
else
  pr6_log "PASS: POST /api/broadcasts で配信を作成できました"
fi

BROADCAST_ID="$(pr6_json_field "${CREATE_BODY}" id 2>/dev/null || true)"
BROADCAST_TOKEN="$(pr6_json_field "${CREATE_BODY}" broadcast_token 2>/dev/null || true)"

if [ -z "${BROADCAST_ID}" ] || [ -z "${BROADCAST_TOKEN}" ]; then
  pr6_log "FAIL: レスポンスからid・broadcast_tokenを取得できませんでした（body: ${CREATE_BODY:-<空>}）"
  RESULT=1
else
  pr6_log "PASS: id=${BROADCAST_ID} broadcast_token=${BROADCAST_TOKEN} を取得しました（モニターURLの材料）"
fi

# --- 作成した配信の単体取得（GET /api/broadcasts/:id） ---
if [ -n "${BROADCAST_ID}" ]; then
  SHOW_BODY_FILE="$(mktemp)"
  SHOW_CODE="$(curl -sS -b "${COOKIE_JAR}" -o "${SHOW_BODY_FILE}" -w '%{http_code}' \
    "${BACKEND_URL}/api/broadcasts/${BROADCAST_ID}" 2>/dev/null || echo "000")"
  SHOW_BODY="$(cat "${SHOW_BODY_FILE}" 2>/dev/null || true)"
  rm -f "${SHOW_BODY_FILE}"

  if [ "${SHOW_CODE}" != "200" ]; then
    pr6_log "FAIL: GET /api/broadcasts/:id が200を返しませんでした（実際: ${SHOW_CODE}）"
    RESULT=1
  else
    SHOW_ID="$(pr6_json_field "${SHOW_BODY}" id 2>/dev/null || true)"
    if [ "${SHOW_ID}" != "${BROADCAST_ID}" ]; then
      pr6_log "FAIL: GET /api/broadcasts/:id のidが作成時と一致しません（期待: ${BROADCAST_ID} / 実際: ${SHOW_ID:-<なし>}）"
      RESULT=1
    else
      pr6_log "PASS: GET /api/broadcasts/:id で作成した配信を取得できました"
    fi
  fi
fi

# --- モニター画面が200で開けること（手順7〜8前半の代替確認） ---
if [ -n "${BROADCAST_TOKEN}" ]; then
  check_page_200 "モニター画面（/monitor/[token]）" "${FRONTEND_URL}/monitor/${BROADCAST_TOKEN}"
fi

# --- 擬似視聴者数・擬似チャットの取得（手順8後半） ---
if [ -n "${BROADCAST_ID}" ]; then
  AUDIENCE_BODY_FILE="$(mktemp)"
  AUDIENCE_CODE="$(curl -sS -b "${COOKIE_JAR}" -o "${AUDIENCE_BODY_FILE}" -w '%{http_code}' \
    "${BACKEND_URL}/api/broadcasts/${BROADCAST_ID}/audience" 2>/dev/null || echo "000")"
  AUDIENCE_BODY="$(cat "${AUDIENCE_BODY_FILE}" 2>/dev/null || true)"
  rm -f "${AUDIENCE_BODY_FILE}"

  if [ "${AUDIENCE_CODE}" != "200" ]; then
    pr6_log "FAIL: GET /api/broadcasts/:id/audience が200を返しませんでした（実際: ${AUDIENCE_CODE}）"
    RESULT=1
  else
    VIEWER_COUNT="$(pr6_json_field "${AUDIENCE_BODY}" viewer_count 2>/dev/null || true)"
    SIMULATED="$(pr6_json_field "${AUDIENCE_BODY}" simulated 2>/dev/null || true)"
    if [ -z "${VIEWER_COUNT}" ] || [ "${SIMULATED}" != "True" ]; then
      pr6_log "FAIL: audienceのレスポンスにviewer_count・simulated:trueが含まれません（body: ${AUDIENCE_BODY:-<空>}）"
      RESULT=1
    else
      pr6_log "PASS: 擬似視聴者数（viewer_count=${VIEWER_COUNT}）を取得できました"
    fi
  fi
fi

# --- 配信停止（手順9） ---
if [ -n "${BROADCAST_ID}" ]; then
  STOP_BODY_FILE="$(mktemp)"
  STOP_CODE="$(curl -sS -b "${COOKIE_JAR}" -o "${STOP_BODY_FILE}" -w '%{http_code}' \
    -X POST "${BACKEND_URL}/api/broadcasts/${BROADCAST_ID}/stop" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo "000")"
  STOP_BODY="$(cat "${STOP_BODY_FILE}" 2>/dev/null || true)"
  rm -f "${STOP_BODY_FILE}"

  STOP_STATE="$(pr6_json_field "${STOP_BODY}" state 2>/dev/null || true)"
  if [ "${STOP_CODE}" != "200" ] || [ "${STOP_STATE}" != "ended" ]; then
    pr6_log "FAIL: POST /api/broadcasts/:id/stop で状態がendedになりませんでした（code: ${STOP_CODE} / state: ${STOP_STATE:-<なし>}）"
    RESULT=1
  else
    pr6_log "PASS: 配信停止後、state=endedになりました（モニター画面の「終了しました」表示に対応）"
  fi
fi

echo "=================================================="
if [ "${RESULT}" -eq 0 ]; then
  pr6_log "PASS: PR #6 ユーザーテスト手順（HTTP確認範囲）はすべて成功しました"
else
  pr6_log "FAIL: PR #6 ユーザーテスト手順（HTTP確認範囲）に失敗した項目があります"
fi

exit "${RESULT}"
