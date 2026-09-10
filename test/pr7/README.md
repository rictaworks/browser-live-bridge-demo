# test/pr7

PR #7「デバッグ・仕上げ：結合確認とCLAUDE.mdルール準拠」（issue #4）向けのテストです。

このPRは issue #3（PR #6でマージ済み）完了後の結合確認・不具合修正で、主な変更は以下のとおりです。

- **Rails backendでCORSが未設定で、実ブラウザ経路では配信開始自体が失敗していた問題を修正**
  （`rack-cors`を有効化、`FRONTEND_ORIGIN`環境変数で許可オリジンを明示指定）
- 配信開始→中継到達→モニター再生の一連疎通のE2Eテスト化
  （`src/relay/internal/wsapi/full_pipeline_test.go`、Goのhttptestサーバー＋フェイクbackendで
  既にPR内に実装・確認済み）
- 接続断→再接続シナリオ（16.3節）の同ファイルでの統合テスト（同上、実装・確認済み）
- 日次リセット・配信ロック失効回収（`src/backend/spec/jobs/daily_reset_job_spec.rb`、
  `src/backend/spec/jobs/reclaim_stale_locks_job_spec.rb`等、既存RSpecで実装・確認済み）
- `/internal/**`のid×broadcast_token多層防御（`src/backend/spec/requests/internal/broadcasts_spec.rb`、
  既存RSpecで実装・確認済み）

本ディレクトリはこれらを重複作成せず、tester役割の方針どおり

- (a) issue #4の受け入れ条件のうちHTTPだけで確認できる部分の自動実行
- (b) 既存の単体テスト・Goのhttptestレベル統合テストでは**カバーされていない実サーバー結合確認**
  （CORS実機確認、および実際に稼働しているbackend/relayコンテナ同士のネットワーク越しの結合）

に絞っています。対象はすべて**開発サーバー（ローカルのdocker compose環境、localhost固定・
docker composeの内部ネットワーク）**です。本番サーバー（Railway/Vercel）には一切アクセスしません。

## なぜGoのhttptestレベルのE2Eテストだけでは不十分なのか

`full_pipeline_test.go`は同一プロセス内で`httptest.NewServer`とフェイクbackend
（`newFakeBackend`、常に`valid: true`を返す）を使っています。これは中継層自身のロジック
（フレームの状態遷移・FLV多重化・ローカルingest配送）を検証するには最適ですが、

- 実際の`RELAY_BACKEND_URL`（既定値`http://backend:3001`、docker composeのサービス名解決）が
  本物のRailsアプリに実際に到達し、`POST /internal/broadcasts/verify`・
  `POST /internal/broadcasts/:id/finish`が実データベース上のレコードと正しく照合・更新できるか
- `FRONTEND_ORIGIN`等の環境変数がdocker-compose.ymlで正しく配線され、rack-corsミドルウェアが
  実際に起動したRailsアプリに読み込まれているか

は検証していません。本ディレクトリの`run_full_pipeline_and_reconnect.sh`と
`check_cors_real_server.sh`はこの隙間を、実際にビルド・起動したコンテナ同士の結合で埋めます。

## スクリプト一覧

| スクリプト | 内容 |
|---|---|
| `lib_common.sh` | 他スクリプトから`source`する共通ヘルパー（起動待ち・JSONフィールド取得・配信作成など）。単体では実行しません。 |
| `check_cors_real_server.sh` | CORS実機確認。実際に起動しているbackendコンテナに対し、許可オリジンからのpreflight・本体リクエストにCORSヘッダが返ること、許可外オリジンには返らないこと、Origin未指定でも従来通り動作することを生のHTTPで確認します。`cors_spec.rb`（Rails request spec）と重複させず、環境変数の配線ミスなどrequest specでは検出できない配線レベルの不具合を確認します。 |
| `run_full_pipeline_and_reconnect.sh` | issue #4の受け入れ条件「配信開始→中継到達→モニター再生」「接続断からの再接続シナリオ」を、実際に起動しているbackend/relayコンテナ同士の結合で確認します。加えて、relayが送った終了通知が実際にbackendへ記録され`GET /api/broadcasts/:id`がended/理由を反映すること、オーナーキー分離（session_key・broadcast_tokenの不一致が中継層の実backend照合を通じて致命通知で拒否されること）も確認します。内部で`test/pr7/wsclient`（後述）を使います。 |
| `wsclient/main.go` | 上記スクリプトから`docker compose run`経由で実行される使い捨てのGo製WebSocketクライアントです。relayコンテナと同じGoモジュール（`src/relay`）の`internal/protocol`・`internal/ingest`パッケージを再利用し、`/ws/publish`・`/ws/monitor/:broadcast_token`へ実際のバイナリフレームプロトコルで接続します。**`src/relay`配下のファイルは一切変更しません**（後述の実行方法を参照）。 |
| `run_all.sh` | 上記2本（`check_cors_real_server.sh`・`run_full_pipeline_and_reconnect.sh`）をまとめて実行します。 |

### `wsclient`の実行方法について（src/relayを変更しない理由）

`run_full_pipeline_and_reconnect.sh`は、`wsclient/main.go`を`docker compose run`の
追加の`-v`オプションで、relayサービスのモジュールディレクトリ内（`/app/cmd/testclient`）へ
一時的にバインドマウントしてから`go run ./cmd/testclient`で実行します。

```sh
docker compose run --rm --no-deps \
  -v "$(pwd)/test/pr7/wsclient:/app/cmd/testclient:ro" \
  relay \
  go run ./cmd/testclient -mode=pipeline ...
```

このバインドマウントは実行したコンテナの中だけで有効で、ホスト側の`src/relay`ディレクトリには
何も作成・変更されません（`docker compose run`は使い捨てのコンテナを新規作成するため、常時起動中の
`relay`サービスのコンテナとは別物です。同じdocker composeプロジェクトのネットワークに参加するため、
サービス名`relay:3002`で常時起動中のrelayサービスへ接続できます）。こうすることで、issue #4の
Edit scope（`src/**`は参照のみ・不具合修正以外は変更しない）を守りながら、relayが実際に使っている
プロトコル実装をそのまま結合確認に使えます。

## 使い方

前提: Docker / Docker Compose が利用できること（リポジトリの`README.md`参照）。

```sh
# リポジトリルートで実行
test/pr7/run_all.sh
```

個別に実行する場合:

```sh
test/pr7/check_cors_real_server.sh
test/pr7/run_full_pipeline_and_reconnect.sh
```

未起動のサービス（backend・relay）は各スクリプトが自分で`docker compose up -d --build`し、
確認後に自分が起動した分だけ`docker compose stop`で停止します（既に起動していたサービスは
停止しません）。

## 既存の単体テスト・E2Eテストの実行方法（参考、本ディレクトリでは重複実行しません）

```sh
docker compose run --rm -e RAILS_ENV=test backend bundle exec rspec
docker compose run --rm relay go test ./... -v
docker compose run --rm frontend npm test
```

## 対象外にした範囲とその理由

### 1. 配信開始→中継到達→モニター再生・接続断→再接続の中継層ロジック自体

`src/relay/internal/wsapi/full_pipeline_test.go`（`TestFullPipeline_StudioPublishReachesMonitor`・
`TestFullPipeline_ReconnectAfterDisconnectResumesPublish`）で、状態遷移・FLV多重化・ローカル
ingest配送のロジックは既にGoのhttptestレベルで検証済みです。本ディレクトリの
`run_full_pipeline_and_reconnect.sh`は同じ手順を踏みますが、確認しているのは「実際に起動した
backend/relayコンテナ同士が本物のネットワークで結合しているか」であり、ロジック自体の分岐網羅は
重複させていません。

### 2. 日次リセット・配信ロック失効回収

`src/backend/spec/jobs/daily_reset_job_spec.rb`・`reclaim_stale_locks_job_spec.rb`で既にRSpec
検証済みです。これらは`config/initializers/background_jobs.rb`のアプリケーション内バックグラウンド
ループから`perform_now`で呼ばれるジョブで、外部から起動できるHTTPエンドポイントを持たないため、
本ディレクトリ（HTTP/WebSocket結合確認が対象）では確認できる対象コードがありません。

### 3. モニター同時接続数の上限・到達ストリームの保持時間の上限（非機能要件20節）

`src/relay/internal/ingest/sink_test.go`の`TestSinkTooManySubscribers`・
`TestSinkRetentionPrunesOldTags`で、実装本体（フェイクではない`ingest.Sink`）に対する単体テストとして
既に検証済みです。この上限判定はbackendとの通信を伴わない中継層内部のロジックのため、実サーバー
結合レベルで追加確認すべき対象コードがなく、対象外としています。

### 4. `getDisplayMedia`/`getUserMedia`/WebCodecsを伴う実際の配信送出・実再生

本PRではフロントエンドの画面自体に変更がないため、test/pr6のREADMEに記載した対応関係
（`src/frontend/lib/*.test.ts`でのモック境界を明記したユニットテスト）から変わりません。詳細は
`test/pr6/README.md`を参照してください。実際の映像が乗ること・許可ダイアログの挙動・実再生の
見た目の確認は、人手（Claude Desktopのsandbox browser等）で行ってください。

## メディアクロック・オーナーキー分離・適応制御のテストについて

- メディアクロック: 本PRでの変更対象外です（`src/frontend/lib/mediaClock.test.ts`で既に検証済み、
  test/pr6のREADME参照）。
- オーナーキー分離: REST API（`/api/broadcasts/**`）側は`test/pr6/check_owner_key_isolation.sh`・
  `src/backend/spec/requests/api/broadcasts_spec.rb`で既に確認済みです。本ディレクトリでは、
  test/pr6では対象外だった**中継層（relay）の実backend照合経路**
  （`POST /internal/broadcasts/verify`を実際に呼び出す`/ws/publish`の開始通知処理）について、
  実在の配信のsession_key・broadcast_tokenのいずれかが一致しない場合に致命通知
  （`verification_failed`）で拒否されることを、`run_full_pipeline_and_reconnect.sh`内で
  実backendに対して確認しています。`/internal/**`のid×broadcast_token多層防御自体は
  `src/backend/spec/requests/internal/broadcasts_spec.rb`で既にRSpec検証済みのため重複させていません。
- 適応制御: 本PRでの変更対象外です（`src/frontend/lib/bitrateGovernor.test.ts`・
  `src/relay/internal/ratecontrol/governor_test.go`・`queue_test.go`で既に検証済み、test/pr6の
  README参照）。

## 実行結果（作成時点）

`test/pr7/run_all.sh`をこのリポジトリのdocker compose開発環境で実行し、すべてPASSすることを
確認済みです（backend・relayとも本スクリプトが起動し、確認後に停止しています）。
