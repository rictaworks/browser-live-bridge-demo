# browser-live-bridge-demo

配信ソフト（OBS等）不要で、ブラウザのタブを開くだけで画面共有・カメラ・マイクを合成しライブ配信できることを体験させるデモ版展示物です。仕様の正は [`requirements.md`](requirements.md) をご覧ください。

**現時点ではフロントエンド・アプリケーション層・中継層の雛形のみが実装されています。** 配信パイプライン等の業務ロジックは別issueで実装します。

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

## ページ一覧（雛形時点）

| URL | 名称 |
|---|---|
| `/` | トップページ（フロントエンド） |

## API一覧（雛形時点）

| タイトル | メソッド・URL | 層 |
|---|---|---|
| ヘルスチェック（フロントエンド） | `GET /api/health` | フロントエンド（Next.js） |
| ヘルスチェック（アプリケーション） | `GET /health` | アプリケーション（Rails） |
| ヘルスチェック（中継） | `GET /health` | 中継（Gin） |

いずれも `{"status":"ok"}` 相当のJSONを200で返します。ビジネスロジックは含みません。

## ディレクトリ構成

```
src/frontend/  Next.js（TypeScript）雛形
src/backend/   Rails（APIモード・SQLite）雛形
src/relay/     Gin（Go）雛形
```

## 関連ドキュメント

- 仕様の正: [`requirements.md`](requirements.md)
- 開発方針: [`CLAUDE.md`](CLAUDE.md)
