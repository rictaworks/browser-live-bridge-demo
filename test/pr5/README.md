# test/pr5

PR #5「環境構築：Next.js / Rails / Gin の雛形とdev環境整備」向けのテストです。
このissueは3層の雛形（`GET /health` / `GET /api/health`のみ）で独自のビジネスロジックを
持たないため、DOCS/TM.mdの方針に沿って層ごとに以下のテストが**既にPR#5内に**用意されています。

- アプリケーション（Rails）: `src/backend/spec/requests/health_spec.rb`（RSpec）
- 中継（Gin/Go）: `src/relay/main_test.go`（Go標準の`testing`）

本ディレクトリはそれらを重複作成せず、(a) PR本文に書かれたユーザーテスト手順の自動実行、
(b) 上記の既存テストが実際に`docker compose run`経由で実行可能かの確認、(c) Jestを使わない
方針のフロントエンド`GET /api/health`のcurlベース確認、を行います。

対象はすべて**開発サーバー（ローカルのdocker compose環境、localhost固定）**です。本番サーバー
（Railway/Vercel）には一切アクセスしません。

## スクリプト一覧

| スクリプト | 内容 |
|---|---|
| `run_user_test.sh` | PR本文のユーザーテスト手順そのもの。`docker compose up` → 3つのヘルスチェックURL（フロントエンド/アプリケーション/中継）が`{"status":"ok"}`を返すことを確認 → `docker compose down`。 |
| `verify_backend_rspec_via_compose.sh` | `docker compose run --rm -e RAILS_ENV=test backend bundle exec rspec` を実行し、既存の`health_spec.rb`がdev環境のcomposeコマンド経由で通ることを確認。 |
| `verify_relay_go_test_via_compose.sh` | `docker compose run --rm relay go test ./... -v` を実行し、既存の`main_test.go`がdev環境のcomposeコマンド経由で通ることを確認。 |
| `check_frontend_health.sh` | `GET http://localhost:3000/api/health` をcurlで確認（HTTPステータス200・Content-Type: application/json・ボディが`{"status":"ok"}`と完全一致）。未起動時はfrontendサービスのみ起動し、確認後に自分が起動した分だけ停止する。 |
| `run_all.sh` | 上記を まとめて実行する（backend RSpec → relay go test → ユーザーテスト手順の順）。 |

## 使い方

前提: Docker / Docker Compose が利用できること（リポジトリの`README.md`参照）。

```sh
# リポジトリルートで実行
test/pr5/run_all.sh
```

個別に実行する場合:

```sh
test/pr5/verify_backend_rspec_via_compose.sh
test/pr5/verify_relay_go_test_via_compose.sh
test/pr5/run_user_test.sh
test/pr5/check_frontend_health.sh
```

## メディアクロック・オーナーキー分離・適応制御のテストについて

PR #5は環境構築の雛形のみで、配信パイプライン・セッション管理・適応制御ロジックを一切
含まないため（`Closes #2`、業務ロジックはissue #3以降）、tester役割で定めている以下の観点は
本PRには該当対象コードが存在せず、本ディレクトリでは扱っていません。該当するロジックが
実装されるPR（issue #3以降）で追加します。

- メディアクロックの単体テスト（requirements.md 6.5節）
- オーナーキー分離のテスト（requirements.md 9節・21節）
- 適応制御のテスト（requirements.md 7節）
