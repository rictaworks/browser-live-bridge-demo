#!/usr/bin/env bash
# PR #6 のtest/pr6配下のテストをまとめて実行するスクリプトです。
#
# 実行順序:
#   1. run_user_test.sh              … PR本文のユーザーテスト手順（HTTP確認範囲）
#   2. check_owner_key_isolation.sh  … オーナーキー分離の結合確認（curlベース）
#
# 単体テスト（backend RSpec 61件・relay go test 9パッケージ・frontend Jest 132件）は
# 本PRで既に実装・確認済みのため、本スクリプトでは重複実行しません。
# `docker compose run --rm backend bundle exec rspec` 等での確認方法はREADME.mdを参照してください。
#
# 対象は開発サーバー（ローカルのdocker compose環境、localhost固定）のみです。
# 本番サーバーには一切アクセスしません。
#
# 使い方:
#   test/pr6/run_all.sh
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

run_step "run_user_test.sh"
run_step "check_owner_key_isolation.sh"

echo "=================================================="
if [ "${RESULT}" -eq 0 ]; then
  echo "PASS: PR #6 のtest/pr6テストはすべて成功しました"
else
  echo "FAIL: PR #6 のtest/pr6テストに失敗した項目があります。上記ログを確認してください。"
fi

exit "${RESULT}"
