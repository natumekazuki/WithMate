# WithMate

WithMate は、`Codex CLI / GitHub Copilot CLI` 相当の coding agent 体験をベースに、キャラクターロールプレイを重ねる Electron アプリです。

現状は `Home Window` / `Session Window` / `Character Editor Window` / `Diff Window` を持つデスクトップ構成で、ワークスペース選択、セッション起動、キャラクター管理、差分確認、セッション継続までを扱います。

## 何を目指すアプリか

- coding agent としての操作感を CLI に近づける
- `character.md` を通じて安定したキャラクター性をセッションへ注入する
- 作業体験を壊さずに、WithMate 固有のキャラクター拡張を載せる

プロダクト方針の詳細は `docs/design/product-direction.md` を参照してください。

## 現在の構成

### Window 構成

- `Home Window`
  - セッション一覧の確認
  - 新規セッション起動
  - キャラクター一覧の確認
  - Settings overlay の起点
- `Session Window`
  - coding agent との作業チャット
  - approval mode の反映
  - model / depth の反映
  - turn ごとの結果確認
  - 監査ログ確認
- `Character Editor Window`
  - キャラクター作成、編集、削除

設計の詳細は `docs/design/window-architecture.md` を参照してください。

### 技術スタック

- Electron
- React
- Vite
- TypeScript
- `@openai/codex-sdk`
- `@github/copilot-sdk`

## セットアップ

### 前提

- Node.js
- npm

### 依存関係のインストール

```bash
npm install
```

## 開発コマンド

### Renderer 開発サーバー

```bash
npm run dev
```

### Electron 開発起動

別ターミナルで renderer を起動したうえで、Electron 側を立ち上げます。

```bash
npm run electron:dev
```

`electron:dev` は既定で `http://localhost:4173` を参照します。

### 本番向けビルド

```bash
npm run build
```

### ビルド済みアプリの起動

```bash
npm run electron:start
```

### 型チェック

```bash
npm run typecheck
```

## ディレクトリガイド

- `src/`
  - React renderer 側の UI 実装
- `src-electron/`
  - Electron main process / preload / 永続化処理
- `docs/design/`
  - 現在の仕様と設計メモ
- `docs/plans/`
  - 実装タスクの計画と進捗ログ
- `.ai_context/`
  - AI エージェント向けの高密度コンテキスト置き場
- `characters/`
  - キャラクター定義の管理領域

## まず読むとよいドキュメント

- `docs/design/product-direction.md`
  - WithMate の優先順位と価値仮説
- `docs/design/coding-agent-capability-matrix.md`
  - coding agent wrapper 観点の対応機能一覧と current status
- `docs/design/window-architecture.md`
  - Window ごとの責務分離
- `docs/design/desktop-ui.md`
  - 現行 UI の構成
- `docs/design/prompt-composition.md`
  - settings prefix / character role / input prompt の合成方針
- `docs/design/audit-log.md`
  - Session 実行の監査ログ設計
- `docs/design/database-schema.md`
  - current の保存構造と DB / file storage の一覧
- `docs/manual-test-checklist.md`
  - 現行実装に対する実機テスト項目表
- `docs/design/manual-test-checklist.md`
  - 実機テスト項目表の運用方針
- `docs/design/session-launch-ui.md`
  - 新規セッション起動 UI の考え方
- `docs/design/character-storage.md`
  - キャラクター保存まわりの設計
- `docs/design/session-persistence.md`
  - セッション永続化の設計

## 現在の状態

- Electron 実行を正本とする desktop アプリ構成です
- セッション情報は Electron 側で保持され、キャラクター情報はストレージから読み込みます
- Settings overlay では `System Prompt Prefix`、`Coding Agent Providers`、`Coding Agent Credentials`、model catalog、`Danger Zone` の DB 初期化を管理します
- current Settings の provider / credential は coding plane 専用です。`Character Stream` 用 API 入力欄は current milestone では追加していません
- 初回リリース前のため後方互換性は考慮しません。互換性のない変更が入った場合は Settings の `DB を初期化` で回復する前提です
- `DB を初期化` は `sessions / audit logs / app settings / model catalog` を初期状態へ戻し、`characters` は削除しません
- `Character Stream` は価値仮説として保持しているものの、current milestone では未着手です

## 補足

- ルート `README.md` は人間向けの入口として維持します
- 詳細仕様は `docs/` を正本とし、構造化された AI 向け情報は `.ai_context/` に集約する想定です
- coding agent の対応状況を確認するときは `docs/design/coding-agent-capability-matrix.md` を最初に見ます
- coding agent capability に影響する実装や改修では、同じ task の中で `docs/design/coding-agent-capability-matrix.md` を更新します
- 永続化構造、SQLite schema、JSON カラム、DB 外保存の責務に変更がある task では、同じ task の中で `docs/design/database-schema.md` も更新します
- provider ごとの詳細設計は `docs/design/provider-adapter.md`、`docs/design/codex-approval-research.md`、`docs/design/slash-command-integration.md`、`docs/design/skill-command-design.md` を参照します
