#!/usr/bin/env bash
# PR #7 のtest/pr7配下のテストをまとめて実行するスクリプトです。
#
# 実行順序:
#   1. check_cors_real_server.sh          … CORS実機確認（issue #4の主要な不具合修正）
#   2. run_full_pipeline_and_reconnect.sh … 配信開始→中継到達→モニター再生、
#                                            接続断からの再接続、オーナーキー分離（中継層）を
#                                            実際のbackend/relayコンテナ同士の結合で確認
#
# 単体テスト（backend RSpec・relay go test・frontend Jest）や、Goのhttptestレベルの
# E2Eテスト（src/relay/internal/wsapi/full_pipeline_test.go）は本PRで既に実装・確認済みの
# ため、本スクリプトでは重複実行しません。日次リセットもRSpec
# （src/backend/spec/jobs/daily_reset_job_spec.rb 等）で既に検証済みで、HTTP経由で
# 起動できる操作ではないため対象外です（詳細はREADME.md参照）。
#
# 対象は開発サーバー（ローカルのdocker compose環境、localhost固定）のみです。
# 本番サーバーには一切アクセスしません。
#
# 使い方:
#   test/pr7/run_all.sh
#
# 終了コード: 0=すべて成功 / 1=いずれか失敗

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT=0

run_step() {
  local script="$1"
  echo "=================================================="
  echo "実行: ${script}"
  echo "=================================================="
  if ! "${SCRIPT_DIR}/${script}"; then
    RESULT=1
  fi
}

run_step "check_cors_real_server.sh"
run_step "run_full_pipeline_and_reconnect.sh"

echo "=================================================="
if [ "${RESULT}" -eq 0 ]; then
  echo "PASS: PR #7 のtest/pr7テストはすべて成功しました"
else
  echo "FAIL: PR #7 のtest/pr7テストに失敗した項目があります。上記ログを確認してください。"
fi

exit "${RESULT}"
