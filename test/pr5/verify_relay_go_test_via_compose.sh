#!/usr/bin/env bash
# PR #5 検証: 中継層（Gin/Go）の既存テスト（src/relay/main_test.go）が
# docker compose 経由（= 開発者が実際に使うコマンド）で実行可能かを確認するスクリプトです。
#
# TM.md の方針どおりGoのテストはGo標準の testing パッケージを用いており、テスト自体は
# 既にPR#5内の src/relay/main_test.go に実装済みのため、本スクリプトはテストの重複作成は
# せず「docker compose run 経由で実行できること」の確認に専念します。
#
# 対象は開発用のdocker composeイメージのみです。本番サーバーへは一切アクセスしません。
#
# 使い方:
#   test/pr5/verify_relay_go_test_via_compose.sh
#
# 終了コード: 0=go test成功 / 1=失敗

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

log() {
  echo "[verify_relay_go_test_via_compose] $*"
}

log "docker compose run --rm relay go test ./... -v を実行します"
if docker compose run --rm relay go test ./... -v; then
  log "PASS: relay の go test は docker compose run 経由で成功しました"
  exit 0
else
  log "FAIL: relay の go test が docker compose run 経由で失敗しました"
  exit 1
fi
