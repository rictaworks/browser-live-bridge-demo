# browser-live-bridge-demo

配信ソフト（OBS等）不要で、ブラウザのタブを開くだけで画面共有・カメラ・マイクを合成しライブ配信できることを体験させるデモ版展示物です。仕様の正は [`requirements.md`](requirements.md) をご覧ください。

配信パイプライン全体（ソース取得・映像合成・音声混合・エンコード・転送・中継・モニター配信）を実装済みです。

## 開発環境の起動方法

開発環境はWSL2上のDockerコンテナで完結する構成です。ホストにNode.js・Ruby・Goなどを個別にインストールする必要はありません。

### 前提

- Docker / Docker Compose が利用できること

### シークレットの準備

アプリケーション層（Rails）は `RAILS_MASTER_KEY` を環境変数で必要とします。`config/master.key` はコミット対象外のため、初回のみ以下の手順で準備してください。

1. `.env.example` を `.env` にコピーします（`.env` はコミット対象外です）
2. `src/backend/config/master.key` の内容を `.env` の `RAILS_MASTER_KEY` に設定します（`src/backend` 側で `rails new` 済みのマスターキーがある場合はそれを使用し、無い場合は各自の開発環境で `bin/rails credentials:edit` 等により生成してください）
3. コミット前には必ず `git status` でステージング内容を確認し、`config/master.key` や `.env` が含まれていないことを確認してください

### 起動

リポジトリルートで以下を実行します。

```sh
docker compose up
```

初回はイメージのビルドに時間がかかります。個別にビルドしたい場合は次のコマンドを利用してください。

```sh
docker compose build
```

起動後、以下のポートで各層にアクセスできます。

| 層 | URL |
|---|---|
| フロントエンド（Next.js） | http://localhost:3000 |
| アプリケーション（Rails） | http://localhost:3001 |
| 中継（Gin） | http://localhost:3002 |

停止する場合は以下を実行します。

```sh
docker compose down
```

## ページ一覧

| URL | 名称 |
|---|---|
| `/` | トップページ（フロントエンド） |
| `/studio` | 配信スタジオ画面。ソース取得・プレビュー・配信制御・健全性・視聴情報・チャット・イベントログ |
| `/monitor/:token` | モニター画面。配信トークンを知る者のみが到達でき、ローカルingestに到達した映像を視聴できる |

## API一覧

### 配信者向けAPI（`/api/broadcasts/**`、Cookieセッションスコープ、backend）

| タイトル | メソッド・URL |
|---|---|
| 配信作成＋配信ロック取得 | `POST /api/broadcasts` |
| ソース構成の追加/更新 | `POST /api/broadcasts/:id/sources` |
| 配信ロックの生存通知 | `POST /api/broadcasts/:id/lock/heartbeat` |
| 配信停止 | `POST /api/broadcasts/:id/stop` |
| 配信状態取得 | `GET /api/broadcasts/:id` |
| 擬似視聴者数・擬似チャットの取得 | `GET /api/broadcasts/:id/audience` |
| 配信者本人の投稿 | `POST /api/broadcasts/:id/chat` |
| イベントログ取得 | `GET /api/broadcasts/:id/events` |

### 中継内部API（`/internal/**`、backend、Railway内部通信専用）

| タイトル | メソッド・URL |
|---|---|
| 開始通知の照合 | `POST /internal/broadcasts/verify` |
| 健全性サンプルの記録 | `POST /internal/broadcasts/:id/health_samples` |
| イベントの記録 | `POST /internal/broadcasts/:id/events` |
| 配信終了の記録・ロック解放 | `POST /internal/broadcasts/:id/finish` |

### WebSocket（中継、relay）

| タイトル | URL |
|---|---|
| 配信スタジオからのフレーム受信 | `ws(s)://<relay-host>/ws/publish` |
| モニターへの映像配信 | `ws(s)://<relay-host>/ws/monitor/:broadcast_token` |

### ヘルスチェック

| タイトル | メソッド・URL | 層 |
|---|---|---|
| ヘルスチェック（フロントエンド） | `GET /api/health` | フロントエンド（Next.js） |
| ヘルスチェック（アプリケーション） | `GET /health` | アプリケーション（Rails） |
| ヘルスチェック（中継） | `GET /health` | 中継（Gin） |

## ディレクトリ構成

```
src/frontend/  Next.js（TypeScript）。配信スタジオ画面・モニター画面
src/backend/   Rails（APIモード・SQLite）。配信レコードAPI・擬似視聴者/チャット生成・日次リセット
src/relay/     Gin（Go）。WebSocket受信・FLV多重化・RTMP publish・ローカルingest・モニター配信
```

## 関連ドキュメント

- 仕様の正: [`requirements.md`](requirements.md)
- 開発方針: [`CLAUDE.md`](CLAUDE.md)
