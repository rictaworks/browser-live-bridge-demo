#!/usr/bin/env bash
# PR #6 結合確認: オーナーキー分離（requirements.md 9節・21節）を、実際に稼働している
# 開発サーバー（backend, localhost:3001）に対するHTTPリクエストで検証します。
#
# src/backend/spec/requests/api/broadcasts_spec.rb 内で同種の確認がRSpec（Rails内部の
# ActionDispatch::Integration::Sessionを2つ使う）としてすでに実装されていますが、本スクリプトは
# それとは別に「別プロセスのcurlが、Cookie（セッションキー）だけを頼りに実際のHTTP経由で
# 他者の配信へ到達できないこと」を確認します。cookie_store・CORS・ルーティングを含めた
# 実際の疎通経路を通すという点で、RSpecのin-process確認を補完する結合的なチェックです。
#
# 検証内容:
#   - セッションA（Cookie A）で配信を作成する
#   - セッションB（Cookie B、別のcookie jar＝別セッション）から、Aの配信IDに対して
#     GET / POST sources / POST stop / GET audience / POST chat / GET events を試み、
#     いずれも404（not_found）で、存在の有無も含めて漏れないことを確認する
#   - セッションAからは引き続き取得でき、Bの操作によって状態が変化していないことを確認する
#
# 対象は開発サーバー（ローカルのdocker compose環境、localhost固定）のみです。
# 本番サーバーには一切アクセスしません。
#
# 使い方:
#   test/pr6/check_owner_key_isolation.sh
#
# 終了コード: 0=分離できている（すべて期待通り） / 1=失敗（分離できていない、または疎通不可）

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"
# shellcheck source=./lib_common.sh
source "${SCRIPT_DIR}/lib_common.sh"

RESULT=0
STARTED_BACKEND=0
COOKIE_A="$(mktemp)"
COOKIE_B="$(mktemp)"

cleanup() {
  rm -f "${COOKIE_A}" "${COOKIE_B}"
  if [ "${STARTED_BACKEND}" -eq 1 ]; then
    pr6_log "自スクリプトが起動したbackendコンテナを停止します"
    docker compose stop backend >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! curl -fsS -o /dev/null "${BACKEND_URL}/health" 2>/dev/null; then
  pr6_log "backend が未起動のため docker compose up -d --build backend を実行します"
  if ! docker compose up -d --build backend; then
    pr6_log "FAIL: backend の起動に失敗しました"
    exit 1
  fi
  STARTED_BACKEND=1
  if ! pr6_wait_for_http "${BACKEND_URL}/health" 180; then
    pr6_log "FAIL: backend が起動待ちタイムアウトしました"
    exit 1
  fi
fi

expect_code() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "${actual}" != "${expected}" ]; then
    pr6_log "FAIL: ${label}（期待: ${expected} / 実際: ${actual}）"
    RESULT=1
    return 1
  fi
  pr6_log "PASS: ${label}"
  return 0
}

# --- セッションAで配信を作成 ---
CREATE_BODY_FILE="$(mktemp)"
CREATE_CODE="$(curl -sS -c "${COOKIE_A}" -o "${CREATE_BODY_FILE}" -w '%{http_code}' \
  -X POST "${BACKEND_URL}/api/broadcasts" \
  -H 'Content-Type: application/json' \
  -d '{"layout_preset":"screen_primary","title":"owner isolation test"}' 2>/dev/null || echo "000")"
CREATE_BODY="$(cat "${CREATE_BODY_FILE}" 2>/dev/null || true)"
rm -f "${CREATE_BODY_FILE}"

if ! expect_code "セッションAでの配信作成（201）" "201" "${CREATE_CODE}"; then
  pr6_log "FAIL: 配信作成に失敗したため以降の分離確認を中止します（body: ${CREATE_BODY:-<空>}）"
  exit 1
fi

BROADCAST_ID="$(pr6_json_field "${CREATE_BODY}" id 2>/dev/null || true)"
if [ -z "${BROADCAST_ID}" ]; then
  pr6_log "FAIL: 作成レスポンスからidを取得できませんでした（body: ${CREATE_BODY:-<空>}）"
  exit 1
fi
pr6_log "セッションAが配信 id=${BROADCAST_ID} を作成しました"

# セッションBのCookie jarを、セッションAとは無関係な状態にしておくため、
# 別のダミーリクエストで独自のセッションキーを先に発行させておく。
curl -sS -c "${COOKIE_B}" -o /dev/null "${BACKEND_URL}/health" 2>/dev/null || true

# --- セッションB（他者）から、Aの配信IDへのアクセスを試みる ---
intruder_code() {
  local method="$1"
  local path="$2"
  local extra_data="${3:-}"
  if [ -n "${extra_data}" ]; then
    curl -sS -o /dev/null -w '%{http_code}' -b "${COOKIE_B}" -c "${COOKIE_B}" \
      -X "${method}" "${BACKEND_URL}${path}" -H 'Content-Type: application/json' \
      -d "${extra_data}" 2>/dev/null || echo "000"
  else
    curl -sS -o /dev/null -w '%{http_code}' -b "${COOKIE_B}" -c "${COOKIE_B}" \
      -X "${method}" "${BACKEND_URL}${path}" 2>/dev/null || echo "000"
  fi
}

CODE="$(intruder_code GET "/api/broadcasts/${BROADCAST_ID}")"
expect_code "セッションBからGET /api/broadcasts/:id（他者IDは404であること）" "404" "${CODE}"

CODE="$(intruder_code POST "/api/broadcasts/${BROADCAST_ID}/sources" '{"kind":"camera","role":"pip","enabled":true}')"
expect_code "セッションBからPOST /api/broadcasts/:id/sources（他者IDは404であること）" "404" "${CODE}"

CODE="$(intruder_code GET "/api/broadcasts/${BROADCAST_ID}/audience")"
expect_code "セッションBからGET /api/broadcasts/:id/audience（他者IDは404であること）" "404" "${CODE}"

CODE="$(intruder_code POST "/api/broadcasts/${BROADCAST_ID}/chat" '{"body":"乗っ取り投稿"}')"
expect_code "セッションBからPOST /api/broadcasts/:id/chat（他者IDは404であること）" "404" "${CODE}"

CODE="$(intruder_code GET "/api/broadcasts/${BROADCAST_ID}/events")"
expect_code "セッションBからGET /api/broadcasts/:id/events（他者IDは404であること）" "404" "${CODE}"

CODE="$(intruder_code POST "/api/broadcasts/${BROADCAST_ID}/stop" '{}')"
expect_code "セッションBからPOST /api/broadcasts/:id/stop（他者IDは404であること）" "404" "${CODE}"

# --- 本人（セッションA）からは引き続き到達でき、Bの操作で状態が変わっていないことの対照確認 ---
SHOW_BODY_FILE="$(mktemp)"
SHOW_CODE="$(curl -sS -b "${COOKIE_A}" -o "${SHOW_BODY_FILE}" -w '%{http_code}' \
  "${BACKEND_URL}/api/broadcasts/${BROADCAST_ID}" 2>/dev/null || echo "000")"
SHOW_BODY="$(cat "${SHOW_BODY_FILE}" 2>/dev/null || true)"
rm -f "${SHOW_BODY_FILE}"

if expect_code "セッションAからGET /api/broadcasts/:id（本人は200であること）" "200" "${SHOW_CODE}"; then
  SHOW_STATE="$(pr6_json_field "${SHOW_BODY}" state 2>/dev/null || true)"
  if [ "${SHOW_STATE}" = "ended" ]; then
    pr6_log "FAIL: セッションBのstop試行によって状態がendedになってしまいました（オーナーキー分離が破られています）"
    RESULT=1
  else
    pr6_log "PASS: セッションBの一連の試行後も配信の状態はendedになっていません（state=${SHOW_STATE:-<不明>}）"
  fi
fi

echo "=================================================="
if [ "${RESULT}" -eq 0 ]; then
  pr6_log "PASS: オーナーキー分離（結合確認）はすべて成功しました"
else
  pr6_log "FAIL: オーナーキー分離（結合確認）に失敗した項目があります"
fi

exit "${RESULT}"
