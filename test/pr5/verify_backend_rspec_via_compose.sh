#!/usr/bin/env bash
# PR #5 検証: アプリケーション層（Rails）の既存RSpec（spec/requests/health_spec.rb）が
# docker compose 経由（= 開発者が実際に使うコマンド）で実行可能かを確認するスクリプトです。
#
# TM.md の方針どおりRuby/RailsのテストはRSpecを用いており、テスト自体は既にPR#5内の
# src/backend/spec/requests/health_spec.rb に実装済みのため、本スクリプトはテストの
# 重複作成はせず「docker compose run 経由で実行できること」の確認に専念します。
#
# 対象は開発用のdocker composeイメージ（RAILS_ENV=test）のみです。本番サーバーへは
# 一切アクセスしません。
#
# 使い方:
#   test/pr5/verify_backend_rspec_via_compose.sh
#
# 終了コード: 0=RSpec成功 / 1=失敗

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

log() {
  echo "[verify_backend_rspec_via_compose] $*"
}

log "docker compose run --rm backend bundle exec rspec を実行します（RAILS_ENV=test）"
if docker compose run --rm -e RAILS_ENV=test backend bundle exec rspec; then
  log "PASS: backend の RSpec は docker compose run 経由で成功しました"
  exit 0
else
  log "FAIL: backend の RSpec が docker compose run 経由で失敗しました"
  exit 1
fi
