# test/pr6

PR #6「コア実装（ワンショット）：配信パイプライン全体」向けのテストです。

このPRは配信パイプライン全体（フロントエンドの配信スタジオ画面・モニター画面、バックエンドAPI、
中継層のWebSocket/FLV/RTMP）を実装したもので、以下の単体テストが**既にPR #6内に**実装・確認済みです。

- アプリケーション（Rails）: `src/backend/spec/**/*_spec.rb`（RSpec 61件）
- 中継（Gin/Go）: `src/relay/**/*_test.go`（Go標準の`testing`、9パッケージ）
- フロントエンド（Next.js）: `src/frontend/lib/*.test.ts`（Jest 132件）

本ディレクトリはそれらを重複作成せず、(a) PR本文に書かれたユーザーテスト手順のうち
**ブラウザの許可が不要でHTTPだけで確認できる部分**の自動実行、(b) 既存の単体テストではカバー
されていない**結合的な確認**（オーナーキー分離の実HTTP確認）を行います。

対象はすべて**開発サーバー（ローカルのdocker compose環境、localhost固定）**です。本番サーバー
（Railway/Vercel）には一切アクセスしません。

## スクリプト一覧

| スクリプト | 内容 |
|---|---|
| `lib_common.sh` | 他スクリプトから`source`する共通ヘルパー（起動待ち・JSONフィールド取得など）。単体では実行しません。 |
| `run_user_test.sh` | PR本文のユーザーテスト手順のうち、HTTPだけで確認できる部分を自動実行します。3層のヘルスチェック→`/studio`が200→`POST /api/broadcasts`で配信作成→`GET /api/broadcasts/:id`で取得→`/monitor/[token]`が200→`GET /api/broadcasts/:id/audience`で擬似視聴者数取得→`POST /api/broadcasts/:id/stop`で状態がendedになることを確認します。未起動のサービスは自分で起動し、確認後に自分が起動した分だけ停止します。 |
| `check_owner_key_isolation.sh` | オーナーキー分離（requirements.md 9節・21節）の結合確認。異なるセッション（別のcookie jar）で他者の配信IDへ`GET`/`sources`/`audience`/`chat`/`events`/`stop`を試み、いずれも404（存在の有無も漏らさない）で、本人の配信状態が変化していないことを実際のHTTPリクエストで確認します。 |
| `run_all.sh` | 上記2本をまとめて実行します。 |

## 使い方

前提: Docker / Docker Compose が利用できること（リポジトリの`README.md`参照）。

```sh
# リポジトリルートで実行
test/pr6/run_all.sh
```

個別に実行する場合:

```sh
test/pr6/run_user_test.sh
test/pr6/check_owner_key_isolation.sh
```

## 既存の単体テストの実行方法（参考、本ディレクトリでは重複実行しません）

```sh
docker compose run --rm -e RAILS_ENV=test backend bundle exec rspec
docker compose run --rm relay go test ./... -v
docker compose run --rm frontend npm test
```

## 対象外にした範囲とその理由

### 1. `getDisplayMedia` / `getUserMedia` / WebCodecsを伴う実際の配信送出

PR本文のユーザーテスト手順3〜5（画面共有・カメラ・マイクの許可、プレビュー確認）、6〜8
（配信開始・モニターでの実再生確認）は、tester役割の方針どおり**ブラウザのメディアAPIが
playwrightでも自動許可できない場合がある**ため、モック境界を明記した上でユニットテスト側に
倒しています（本PRで既に実装済み）。具体的な対応先は以下のとおりです。

| 手順 | 対応する既存ユニットテスト | モック境界 |
|---|---|---|
| 画面共有・カメラ・マイク取得、プレビュー | `src/frontend/lib/sourceManager.test.ts` | `getDisplayMedia`/`getUserMedia`をモックしたMediaStreamで検証 |
| 映像合成・音声混合 | `src/frontend/lib/videoCompositor.test.ts`・`src/frontend/lib/audioMixer.test.ts` | Canvas/AudioContext相当をモックして合成ロジックのみ検証 |
| メディアクロック（実時計非依存、6.5節） | `src/frontend/lib/mediaClock.test.ts` | 実時計を使わず、フレーム番号・累積サンプル数から時刻を算出するロジックを直接検証 |
| WebCodecsエンコード・送信キュー | `src/frontend/lib/encoderPipeline.test.ts`・`src/frontend/lib/sendQueue.test.ts` | `VideoEncoder`/`AudioEncoder`をモックしてエンコード呼び出し・キューイングのみ検証 |
| 適応制御（7節、滞留時間評価） | `src/frontend/lib/bitrateGovernor.test.ts`、`src/relay/internal/ratecontrol/governor_test.go`・`queue_test.go` | 実時計・実ネットワークを使わず、滞留時間とビットレート増減の対応、音声・キーフレームが破棄対象外であることをロジック単体で検証（`queue_test.go`の`TestDropOldestNonKeyVideoSkipsAudioAndKeyframes`） |
| モニターの実再生（flv.js/MSE） | `src/frontend/lib/flvWebSocketLoader.test.ts`・`src/frontend/lib/monitorClient.test.ts` | WebSocket・flv.jsのcustomLoaderインターフェースをモックして状態遷移のみ検証 |

このため本ディレクトリでは、`/studio`・`/monitor/[token]`が**200で開けること**（画面自体が
壊れていないこと）と、配信作成・取得・擬似視聴情報・停止という**API契約がHTTPレベルで
成立していること**の確認にとどめています。実際の映像が乗ること・許可ダイアログの挙動・
実再生の見た目の確認は、PR本文の指示どおり人手（Claude Desktopのsandbox browser等）で
行ってください。

### 2. 3層すべての結合動作の詳細確認（接続断からの復旧など）

PR本文に「issue #4で行う」と明記されているため、本PRのtest/pr6では扱いません。

## メディアクロック・オーナーキー分離・適応制御のテストについて

- メディアクロック: `src/frontend/lib/mediaClock.test.ts`で実装済み（上表参照）。実時計に依存せず、
  フレーム番号・累積サンプル数から時刻を算出するロジックを検証しています。本ディレクトリでは
  追加していません（結合レベルで検証すべき対象コードがなく、HTTPからは観測できないため）。
- オーナーキー分離: `src/backend/spec/requests/api/broadcasts_spec.rb`（Rails内部の
  `ActionDispatch::Integration::Session`を2つ使ったRSpec）で既に検証済みですが、本ディレクトリの
  `check_owner_key_isolation.sh`で**実際に稼働している開発サーバーに対する別プロセスのcurl**から
  同種の確認を行い、`cookie_store`・ルーティングを含めた実際の疎通経路でも分離が機能していることを
  補完的に確認しています。
- 適応制御: `src/frontend/lib/bitrateGovernor.test.ts`・`src/relay/internal/ratecontrol/governor_test.go`・
  `queue_test.go`で実装済み（上表参照）。滞留時間の閾値超過でビットレートが引き下げられること、
  音声・キーフレームが破棄対象外であることをロジック単体で検証しています。HTTP経由での結合確認は
  対象コードが実配信の送出経路（WebSocket/WebCodecs）にあるため、上記の理由により本ディレクトリの
  対象外としています。
