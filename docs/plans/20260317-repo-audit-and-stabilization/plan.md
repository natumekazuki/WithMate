# Plan

## Goal

- WithMate リポジトリ内のコードと文書を全量把握し、要件・設計・実装の対応関係を可視化する。
- 現在実装済み機能、未実装機能、設計から漏れていると推測される機能を、根拠ファイル付きで整理して出力する。
- 表面化しているバグを探索・修正するための実行順序を定義する。
- 潜在バグは別レポート化し、影響と修正案を残す。
- 最後に完成に向けた実装計画を作成し、フェーズごとのコミットポイントを明確化する。

## Scope

- 調査対象
  - `README.md`
  - `package.json`
  - `docs/`
  - `src/`
  - `src-electron/`
  - `characters/`
  - 必要に応じて `scripts/`, `public/`, `dist-electron/`
- 実施対象
  - 要件定義と設計文書の確認
  - 実装機能の棚卸し
  - 未実装 / 設計漏れ候補の抽出
  - 表面バグの探索、優先順位付け、修正
  - 検証
  - 潜在バグレポート作成
  - 完成ロードマップ作成
- 非対象
  - 今この時点での実装変更
  - 大規模リファクタの即時着手
  - 外部 DB ツール前提の調査

## Phase Breakdown

### Phase 1. 調査

- リポジトリ構造と主要エントリポイントを把握する。
- `docs/要件定義_叩き.md` と `docs/design/*.md` を読み、意図された体験と責務分解を整理する。
- `src/` と `src-electron/` を読み、画面・状態・IPC・保存・provider 連携の構造を把握する。
- `characters/` を確認し、キャラクター定義の現状を把握する。

### Phase 2. 監査レポート作成

- 要件 / 設計 / 実装の三点照合表を作る。
- 機能ごとに以下のいずれかへ分類する。
  - 実装済み
  - 部分実装
  - 未実装
  - 設計漏れ候補
- 画面別、ストレージ別、provider 別に証跡ファイルを紐づける。

### Phase 3. 表面バグ探索と修正

- 再現しやすい UI 崩れ、状態不整合、保存不整合、IPC 不整合、例外系を優先する。
- 修正は影響範囲の小さいものから段階的に行う。
- 修正ごとに関連設計とテスト項目を更新する。

### Phase 4. 検証

- 静的検証
  - `npm run typecheck`
  - `npm run build`
- 手動確認
  - Home
  - Session
  - Character Editor
  - Diff Viewer
  - セッション開始 / 再開 / キャンセル / 保存 / 差分確認

### Phase 5. 潜在バグレポート作成

- 今回見つかったが未修正のリスクを列挙する。
- 各項目に以下を付ける。
  - 観測根拠
  - 想定影響
  - 再現条件または発生条件
  - 推奨修正案
  - 優先度

### Phase 6. 完成計画作成

- 要件未達項目をマイルストーンで再整理する。
- 設計未確定事項の解像度を上げる。
- 安定化タスクと機能追加タスクを分けて並べる。

### Phase 7. コミット

- 各フェーズの区切りで成果物と変更内容をコミットする。
- コミットは監査と実装修正を混在させず、粒度を保つ。

## Deliverables

- この plan フォルダ内の管理ファイル
  - `plan.md`
  - `decisions.md`
  - `worklog.md`
  - `result.md`
- 後続フェーズで追加・更新する候補
  - 機能棚卸し一覧
  - 要件 / 設計 / 実装トレーサビリティ
  - バグ修正結果
  - 潜在バグレポート
  - 完成ロードマップ

## Affected Files

- 文書
  - `README.md`
  - `docs/要件定義_叩き.md`
  - `docs/design/*.md`
  - `docs/manual-test-checklist.md`
- renderer
  - `src/App.tsx`
  - `src/HomeApp.tsx`
  - `src/CharacterEditorApp.tsx`
  - `src/Session*`
  - `src/Diff*`
  - `src/app-state.ts`
  - `src/model-catalog.ts`
  - `src/styles.css`
- electron / backend
  - `src-electron/main.ts`
  - `src-electron/preload.ts`
  - `src-electron/*-storage.ts`
  - `src-electron/codex-adapter.ts`
  - `src-electron/workspace-file-search.ts`
- assets
  - `characters/*`
- 計画成果物
  - `docs/plans/20260317-repo-audit-and-stabilization/*`

## Risks

- ドキュメントと実装のズレにより、機能の真の状態判定が難しい可能性がある。
- Electron main / renderer / storage をまたぐ不具合は、単一ファイル修正で閉じない可能性が高い。
- Provider 系は実行環境依存のため、再現性確保に追加条件が必要になる可能性がある。
- UI バグと設計未達が混在して見える箇所では、修正優先順位の見誤りが起きうる。
- SQL ツールが使えない場合、SQLite 実データの確認はコードベースの推定に依存する。

## Validation

- 要件 / 設計 / 実装の整合確認
- `npm run typecheck`
- `npm run build`
- 手動スモークテスト
- 修正後の回帰確認
- レポートに根拠ファイルと判断理由が記載されていることの確認

## Commit Point Proposal

1. Plan / decisions / worklog / result 初期化
2. 全量調査完了と機能棚卸しレポート作成
3. 表面バグの初回修正と検証
4. 追加修正と設計ドキュメント反映
5. 潜在バグレポート、完成計画、最終検証

## Design / Requirement Check

- 優先確認文書
  - `docs/要件定義_叩き.md`
  - `docs/design/product-direction.md`
  - `docs/design/desktop-ui.md`
  - `docs/design/session-run-lifecycle.md`
  - `docs/design/window-architecture.md`
  - `docs/design/character-storage.md`
  - `docs/design/memory-architecture.md`
- 確認観点
  - CLI parity の達成状況
  - キャラクター定義の安定注入
  - Session / Home / Character Editor の責務分離
  - pending 扱いの Character Stream が UI に混入していないか
  - provider / storage / session resume の整合性

## Notes

- SQL ツールが使えない場合は、schema 設計と storage 実装の読解による監査を行う。
- 実装時には、監査成果物、バグ修正、最終計画を分離して記録する。
