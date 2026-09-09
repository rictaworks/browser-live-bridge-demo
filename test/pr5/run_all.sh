#!/usr/bin/env bash
# PR #5 のテスト一式をまとめて実行するスクリプトです。
#
# 実行順序:
#   1. verify_backend_rspec_via_compose.sh … 既存RSpec(health_spec.rb)がdocker compose run経由で通ること
#   2. verify_relay_go_test_via_compose.sh … 既存go test(main_test.go)がdocker compose run経由で通ること
#   3. run_user_test.sh                    … PR本文のユーザーテスト手順（up→3URL確認→down）
#
# 1・2は個別サービスをdocker compose runで起動しては終了するため、3（docker compose up）
# より先に実行しています。対象はすべて開発サーバー（ローカル）です。
#
# 使い方:
#   test/pr5/run_all.sh
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

run_step "verify_backend_rspec_via_compose.sh"
run_step "verify_relay_go_test_via_compose.sh"
run_step "run_user_test.sh"

echo "=================================================="
if [ "${RESULT}" -eq 0 ]; then
  echo "PASS: PR #5 のテストはすべて成功しました"
else
  echo "FAIL: PR #5 のテストに失敗した項目があります。上記ログを確認してください。"
fi

exit "${RESULT}"
