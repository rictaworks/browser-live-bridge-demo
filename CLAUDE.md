# Claude Safety Rules

## 削除系コマンドの禁止（重要）

以下のルールはこのワークスペース内のすべての会話で絶対に守られる：

- Claude はファイルまたはディレクトリを削除するコマンドを一切生成してはならない。
  例：rm, rm -rf, rm *, rmdir, unlink, cache --delete,
      lftp mirror --delete, rsync --delete, git clean -df, find -delete 等。

- 削除が必要な場合でも、Claude は削除コマンドを提案せず、
  「手動で削除してください」といった説明に留めること。

- 削除の推奨・削除操作の自動判断も禁止。

- ssh / lftp / デプロイ系スクリプトを生成する場合でも、
  削除コマンドの生成は禁止。

これらはすべての会話・コード生成に適用される。

## シークレット管理（重要）

- `config/master.key` など機密ファイルを `git add` するコードを生成してはならない
- デプロイスクリプト・セットアップ手順でも同様
- シークレットは必ず環境変数（RAILS_MASTER_KEY 等）で渡すこと
- `.gitignore` への追加を確認する手順を必ずコードに含めること
- 初回コミット前に `git status` でステージング確認を促すこと

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

配信ソフト（OBS等）不要で、**ブラウザのタブを開くだけ**で画面共有・カメラ・マイクを合成しライブ配信できることを体験させるデモ版展示物。ブラウザは RTMP を直接話せないため、**ブラウザ側エンコード＋中継サーバーによる多重化パススルー**でこの断絶を埋める設計を実際に動く形で示す。送出先は自プロセス内の**ローカル ingest**（本番の配信サービスへの実送出は行わない・資格情報も持たない）。

仕様の正は [`requirements.md`](requirements.md)（ER図・DFD・シーケンス図・クラス図・状態遷移図・ユースケース図を含む）。実装前に必ずこちらを参照すること。**このCLAUDE.mdはrequirements.mdの内容を要約・重複しない**——変更は都度requirements.mdを当たること。

## アーキテクチャ

| 層 | 技術 | デプロイ先 | 役割 |
|---|---|---|---|
| フロントエンド | Next.js（TypeScript） | Vercel | 配信スタジオ画面・モニター画面 |
| アプリケーション | Rails | Railway | セッション・配信レコード・チャット・SQLite管理 |
| 中継 | Gin（Go） | Railway | WebSocket受信・FLV多重化・RTMP publish・ローカルingest・モニター配信 |

中継層（Gin）は**再エンコードを行わない**。ブラウザ側でH.264/AACまで仕上げ、中継層は容器の詰め替え（多重化）のみを行うため、処理量は接続数に対して線形に留まる（requirements.md 6.1節）。DBはSQLiteでRailsのみが保持し、中継層は状態を永続化しない（requirements.md 2.3節）。

**認証・認可を設計に組み込まない**（requirements.md 21節）。かわりにCookie＋SQLiteのセッションキーを全テーブルのオーナーキーとして使い、セッションをまたいだ参照・操作を一切許可しない。配信トークン（モニターURL用）はセッションキーから導出しない別の推測不可能な識別子とする。

**メディアクロックは実時計と独立**（映像はフレーム番号、音声は累積サンプル数から時刻を採番）。実時計を使うとスリープ復帰やタブの非アクティブ化で破綻するため、この区別を実装全体で厳守すること（requirements.md 6.5節）。

## 開発フロー

- 自社開発・デモ版につき、フローは `issue > setting & coding > security review > add, commit, push > reviewer & pr-checker > merge > user test` のみ（code-review・audit・security-gate・正式release・reportは省略可）。mainへのマージで本番デプロイされる構成を前提とする
- `main` への直接作業禁止。`src/**` の変更は必ずPRを作成する。ドキュメント等 `src/**` 以外はmainへの直接pushを許可
- 実装は `src/` 以下に置く。開発用スクリプト等は `src` 外に配置する
- TDD厳守（plan > red test > coding > green test）。RSpec・Jest等。フロントの確認はcurl・wget --mirror・playwrightで行う
- commit前に必ずセキュリティレビュー、マージ前に必ずreviewer・pr-checkerを実行する（フック化すること）
- アイコンはFontAwesome、絵文字は使用禁止。ネイティブの `alert()`/`confirm()`/`prompt()` は使用禁止
- 全PRのユーザーテストはClaude Desktopのsandbox browserで行う（本プロジェクトは認証を持たないためログイン手順は不要）
- 日本語版のみ開発する。コンテンツはですます調（本事業はB2B）

`.claude/init-prompt.md` に `rictaworks/context` の `ClaudeCode.md` から本プロジェクト向けに抽出した詳細方針がある（コミット対象外）。

## コマンド

**実装未着手（2026-09-09時点でrequirements.mdのみ）。** ビルド・lint・テストコマンドは最初のissue実装時にここへ追記すること。開発環境はWSL2 devコンテナ（docker compose）を予定している（questboard・x-follower-gate・living-site-evolver と同様のパターン）。