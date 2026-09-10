#!/usr/bin/env bash
# issue #4の受け入れ条件のうち、
#   - 「配信開始 → 中継到達 → モニター再生、の一連の疎通が確認できる（16.1〜16.4節）」
#   - 「接続断からの再接続シナリオ（16.3節）が動作する」
# を、実際に docker compose で起動している backend / relay コンテナ同士の
# 本物のネットワーク越しの結合（relay → backend への POST /internal/broadcasts/verify・
# /internal/broadcasts/:id/finish を含む）で確認します。
#
# src/relay/internal/wsapi/full_pipeline_test.go で同じ手順がGoのhttptestサーバー＋
# フェイクbackendを使って既に検証済みです（本PR内に実装済み）。本スクリプトはそれを
# 重複させず、「フェイクではない、実際に動いているbackendコンテナに対して中継サーバーが
# 本当に照合・記録できているか」という結合レベルの確認に絞っています。
#
# あわせて、オーナーキー分離（requirements.md 9節・21節）のWebSocket/内部API層での
# 確認（session_key・broadcast_tokenのいずれかが実在の配信と一致しない開始通知が
# 実backendへの照合の結果として致命通知で拒否されること）も行います。
# test/pr6のcheck_owner_key_isolation.shはREST API（/api/broadcasts/**）側のみを
# 対象としており、この中継層の照合経路は対象外だったため、ここで補完します。
#
# 実装方法: relayコンテナと同じGoモジュール（src/relay）内のパッケージ
# （internal/protocol・internal/ingest）を再利用する使い捨てWebSocketクライアント
# （test/pr7/wsclient/main.go）を、docker compose run時に /app/cmd/testclient へ
# 追加でバインドマウントしてから `go run ./cmd/testclient` で実行します。
# src/relay配下のファイルは一切変更しません（追加のバインドマウントはこのコンテナ内
# でのみ有効で、ホスト側のsrc/relayディレクトリには何も作成・変更されません）。
#
# 対象は開発サーバー（ローカルのdocker compose環境）のみです。relay→backendの通信も
# docker composeの内部ネットワーク（サービス名解決）を使い、本番サーバーには一切
# アクセスしません。
#
# 使い方:
#   test/pr7/run_full_pipeline_and_reconnect.sh
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
    pr7_log "自スクリプトが起動したサービスを停止します: ${STARTED_SERVICES[*]}"
    docker compose stop "${STARTED_SERVICES[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

pr7_ensure_up backend "${BACKEND_URL}/health" || exit 1
pr7_ensure_up relay "${RELAY_URL}/health" || exit 1

run_wsclient() {
  # docker compose run で新規relayコンテナを起動し、既に稼働中のrelayサービスへ
  # サービス名（relay:3002）で接続させる。test/pr7/wsclientを一時的に
  # /app/cmd/testclientへ追加マウントすることで、src/relay配下を一切変更せずに
  # internal/protocol・internal/ingestパッケージを再利用する。
  docker compose run --rm --no-deps \
    -v "${SCRIPT_DIR}/wsclient:/app/cmd/testclient:ro" \
    relay \
    go run ./cmd/testclient "$@"
}

# --- 1. 配信開始→中継到達→モニター再生、接続断からの再接続 ---
if pr7_create_broadcast "${COOKIE_JAR}" "pr7 full pipeline test"; then
  pr7_log "配信を作成しました（id=${PR7_BROADCAST_ID}）。実relay/backendコンテナに対してpipelineを実行します"

  PIPELINE_OUTPUT="$(run_wsclient -mode=pipeline -relay="${RELAY_WS_BASE}" \
    -session-key="${PR7_SESSION_KEY}" -broadcast-token="${PR7_BROADCAST_TOKEN}" 2>&1)"
  PIPELINE_EXIT=$?
  echo "${PIPELINE_OUTPUT}" | sed 's/^/  /'

  if [ "${PIPELINE_EXIT}" -ne 0 ] || ! grep -q '^RESULT=PASS' <<<"${PIPELINE_OUTPUT}"; then
    pr7_log "FAIL: 配信開始→中継到達→モニター再生／再接続シナリオの実サーバー確認に失敗しました"
    RESULT=1
  else
    pr7_log "PASS: 配信開始→中継到達→モニター再生、および接続断からの再接続シナリオを実relay/backendで確認しました"
  fi

  # --- 2. 終了通知がrelay→backendへ実際に届き、配信状態がendedへ反映されること ---
  DEADLINE=$(( $(date +%s) + 10 ))
  FINAL_STATE=""
  FINAL_REASON=""
  while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
    SHOW_BODY="$(curl -sS -b "${COOKIE_JAR}" "${BACKEND_URL}/api/broadcasts/${PR7_BROADCAST_ID}" 2>/dev/null || true)"
    FINAL_STATE="$(pr7_json_field "${SHOW_BODY}" state 2>/dev/null || true)"
    if [ "${FINAL_STATE}" = "ended" ]; then
      FINAL_REASON="$(pr7_json_field "${SHOW_BODY}" ended_reason 2>/dev/null || true)"
      break
    fi
    sleep 1
  done

  if [ "${FINAL_STATE}" != "ended" ]; then
    pr7_log "FAIL: wsclientが終了通知を送信した後も、backendの配信状態がendedになりませんでした（実際: ${FINAL_STATE:-<なし>}）"
    pr7_log "  relay → backend（POST /internal/broadcasts/:id/finish）の実結合が壊れている可能性があります"
    RESULT=1
  elif [ "${FINAL_REASON}" != "pr7_user_test" ]; then
    pr7_log "FAIL: 配信は終了しましたが、ended_reasonがwsclientの送った終了理由と一致しません（実際: ${FINAL_REASON:-<なし>}）"
    RESULT=1
  else
    pr7_log "PASS: relayが送った終了通知が実際にbackendへ記録され、GET /api/broadcasts/:idにended/pr7_user_testとして反映されました"
  fi
else
  pr7_log "FAIL: 配信の作成に失敗したため、pipelineの実行をスキップしました"
  RESULT=1
fi

# --- 3. オーナーキー分離（WebSocket/内部API層）：不正な組み合わせは致命通知で拒否されること ---
if [ -n "${PR7_SESSION_KEY:-}" ] && [ -n "${PR7_BROADCAST_TOKEN:-}" ]; then
  pr7_log "オーナーキー分離（中継層の照合経路）を確認します"

  WRONG_TOKEN_OUTPUT="$(run_wsclient -mode=reject -relay="${RELAY_WS_BASE}" \
    -session-key="${PR7_SESSION_KEY}" -broadcast-token="not-the-real-broadcast-token" 2>&1)"
  echo "${WRONG_TOKEN_OUTPUT}" | sed 's/^/  /'
  if ! grep -q '^RESULT=PASS' <<<"${WRONG_TOKEN_OUTPUT}"; then
    pr7_log "FAIL: 正しいsession_key・誤ったbroadcast_tokenの組み合わせが拒否されませんでした"
    RESULT=1
  else
    pr7_log "PASS: 正しいsession_key・誤ったbroadcast_tokenの組み合わせは致命通知で拒否されました"
  fi

  WRONG_SESSION_OUTPUT="$(run_wsclient -mode=reject -relay="${RELAY_WS_BASE}" \
    -session-key="not-the-real-session-key" -broadcast-token="${PR7_BROADCAST_TOKEN}" 2>&1)"
  echo "${WRONG_SESSION_OUTPUT}" | sed 's/^/  /'
  if ! grep -q '^RESULT=PASS' <<<"${WRONG_SESSION_OUTPUT}"; then
    pr7_log "FAIL: 誤ったsession_key・正しいbroadcast_tokenの組み合わせが拒否されませんでした"
    RESULT=1
  else
    pr7_log "PASS: 誤ったsession_key・正しいbroadcast_tokenの組み合わせは致命通知で拒否されました"
  fi
else
  pr7_log "FAIL: 配信の作成に失敗したため、オーナーキー分離の確認をスキップしました"
  RESULT=1
fi

echo "=================================================="
if [ "${RESULT}" -eq 0 ]; then
  pr7_log "PASS: 実relay/backendコンテナでの結合確認（配信開始〜再接続〜終了、オーナーキー分離）はすべて成功しました"
else
  pr7_log "FAIL: 実relay/backendコンテナでの結合確認に失敗した項目があります"
fi

exit "${RESULT}"
