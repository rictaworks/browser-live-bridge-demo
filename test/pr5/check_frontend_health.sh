#!/usr/bin/env bash
# PR #5 検証: フロントエンド（Next.js）の GET /api/health を curl で確認するスクリプトです。
#
# 開発方針（CLAUDE.md）に従い、フロントエンドの動作確認はJestではなくcurl/wget --mirror/
# playwrightで行う方針のため、本スクリプトはcurlベースで実装しています。/api/health は
# ビジネスロジックを持たない固定レスポンスのため、Jestによる単体テストの対象としていません。
#
# デフォルトでは既に docker compose up 済みの開発サーバー（localhost:3000）に対して確認
# します。未起動の場合は本スクリプトが frontend サービスのみを起動し、確認後に自分が
# 起動した分だけ停止します（他サービスやユーザーが別途起動したコンテナには影響しません）。
#
# 対象は開発サーバー（localhost固定）のみです。本番サーバー（Vercel）には一切アクセスしません。
#
# 使い方:
#   test/pr5/check_frontend_health.sh
#
# 終了コード: 0=成功 / 1=失敗

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

URL="http://localhost:3000/api/health"
EXPECTED_BODY='{"status":"ok"}'
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-180}"
POLL_INTERVAL_SECONDS=3
STARTED_BY_THIS_SCRIPT=0

log() {
  echo "[check_frontend_health] $*"
}

cleanup() {
  if [ "${STARTED_BY_THIS_SCRIPT}" -eq 1 ]; then
    log "自スクリプトが起動した frontend コンテナを停止します"
    docker compose stop frontend >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

is_up() {
  curl -fsS -o /dev/null "${URL}" 2>/dev/null
}

if ! is_up; then
  log "frontend が未起動のため docker compose up -d --build frontend を実行します"
  if ! docker compose up -d --build frontend; then
    log "FAIL: frontend の起動に失敗しました"
    exit 1
  fi
  STARTED_BY_THIS_SCRIPT=1
fi

log "起動待ち: ${URL}"
waited=0
while [ "${waited}" -lt "${WAIT_TIMEOUT_SECONDS}" ]; do
  if is_up; then
    break
  fi
  sleep "${POLL_INTERVAL_SECONDS}"
  waited=$((waited + POLL_INTERVAL_SECONDS))
done

RESULT=0

HTTP_CODE="$(curl -sS -o /tmp/pr5_frontend_health_body.json -w '%{http_code}' "${URL}" 2>/dev/null || echo "000")"
CONTENT_TYPE="$(curl -sS -o /dev/null -D - "${URL}" 2>/dev/null | grep -i '^content-type:' | tr -d '\r' || true)"
BODY="$(cat /tmp/pr5_frontend_health_body.json 2>/dev/null || true)"

log "HTTPステータス: ${HTTP_CODE}"
log "Content-Type: ${CONTENT_TYPE:-<なし>}"
log "レスポンスボディ: ${BODY:-<空>}"

if [ "${HTTP_CODE}" != "200" ]; then
  log "FAIL: HTTPステータスが200ではありません（${HTTP_CODE}）"
  RESULT=1
fi

case "${CONTENT_TYPE}" in
  *application/json*) ;;
  *)
    log "FAIL: Content-Typeがapplication/jsonではありません"
    RESULT=1
    ;;
esac

if [ "${BODY}" != "${EXPECTED_BODY}" ]; then
  log "FAIL: レスポンスボディが期待値と一致しません（期待: ${EXPECTED_BODY} / 実際: ${BODY}）"
  RESULT=1
fi

if [ "${RESULT}" -eq 0 ]; then
  log "PASS: GET /api/health は期待どおりのレスポンスを返しました"
fi

exit "${RESULT}"
