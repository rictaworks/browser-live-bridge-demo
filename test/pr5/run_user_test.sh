#!/usr/bin/env bash
# PR #5 ユーザーテスト手順の自動実行スクリプト
#
# PR本文（非エンジニア向けユーザーテスト手順）に書かれた手順をそのまま自動化したものです。
#   1. docker compose up
#   2. 3つのヘルスチェックURLで {"status":"ok"} を確認
#   3. docker compose down
#
# 対象は開発サーバー（ローカルのdocker compose環境）のみです。本番サーバー（Railway/Vercel）
# には一切アクセスしません。URLはすべてlocalhost固定です。
#
# 使い方:
#   test/pr5/run_user_test.sh
#
# 終了コード: 0=全項目成功 / 1=いずれか失敗

set -uo pipefail

# リポジトリルートへ移動（このスクリプトは test/pr5/ に置かれている前提）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# 起動に用いるURL（開発サーバー固定。本番URLへは向けない）
FRONTEND_URL="http://localhost:3000/api/health"
BACKEND_URL="http://localhost:3001/health"
RELAY_URL="http://localhost:3002/health"
EXPECTED_BODY='{"status":"ok"}'

# 起動待ちの最大秒数（初回はイメージビルドが走るため長めに取る）
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-300}"
POLL_INTERVAL_SECONDS=3

STARTED_BY_THIS_SCRIPT=0
OVERALL_RESULT=0

log() {
  echo "[run_user_test] $*"
}

cleanup() {
  if [ "${STARTED_BY_THIS_SCRIPT}" -eq 1 ]; then
    log "手順5: docker compose down を実行します"
    docker compose down
  fi
}
trap cleanup EXIT

log "手順1-2: Docker Desktop（docker compose）の疎通を確認します"
if ! docker compose version >/dev/null 2>&1; then
  log "FAIL: docker compose が利用できません。Docker Desktopの起動状態を確認してください。"
  exit 1
fi

log "手順2: docker compose up を実行します（初回はビルドに時間がかかります）"
if ! docker compose up -d --build; then
  log "FAIL: docker compose up に失敗しました"
  exit 1
fi
STARTED_BY_THIS_SCRIPT=1

wait_for_ok() {
  local name="$1"
  local url="$2"
  local waited=0

  log "起動待ち: ${name} (${url})"
  while [ "${waited}" -lt "${WAIT_TIMEOUT_SECONDS}" ]; do
    local body
    body="$(curl -fsS "${url}" 2>/dev/null || true)"
    if [ "${body}" = "${EXPECTED_BODY}" ]; then
      log "OK: ${name} が ${EXPECTED_BODY} を返しました"
      return 0
    fi
    sleep "${POLL_INTERVAL_SECONDS}"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done

  log "FAIL: ${name} (${url}) が ${WAIT_TIMEOUT_SECONDS} 秒以内に ${EXPECTED_BODY} を返しませんでした（最後の応答: ${body:-<接続不可>})"
  return 1
}

log "手順3-4: 3つのヘルスチェックURLを確認します"
wait_for_ok "フロントエンド（Next.js）" "${FRONTEND_URL}" || OVERALL_RESULT=1
wait_for_ok "アプリケーション（Rails）"   "${BACKEND_URL}"  || OVERALL_RESULT=1
wait_for_ok "中継（Gin）"               "${RELAY_URL}"    || OVERALL_RESULT=1

if [ "${OVERALL_RESULT}" -eq 0 ]; then
  log "PASS: すべてのヘルスチェックが正常でした"
else
  log "FAIL: 一部のヘルスチェックが失敗しました。上記ログを確認してください。"
fi

# cleanup は trap EXIT で自動的に docker compose down を実行する（手順5相当）
exit "${OVERALL_RESULT}"
