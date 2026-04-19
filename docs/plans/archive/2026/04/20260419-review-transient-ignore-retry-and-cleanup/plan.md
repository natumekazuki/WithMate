# Plan

- task: transient ignore 読み取り失敗の retry 修正・テスト追加・review ファイル削除
- date: 2026-04-19
- owner: Codex

## 目的

- `src-electron/snapshot-ignore.ts` で一時的な `EACCES` / `EPERM` / `EBUSY` を 1 回で `unreadable` に確定してしまう問題を修正し、scan 中の retry で吸収できるようにする
- race-like エラーと stable unreadable の混在時の優先ルールを明確化する
- 回帰テストを追加して再発を防ぐ
- 完了後に `docs/reviews/` 配下の review ファイルをすべて削除する

## スコープ

- `src-electron/snapshot-ignore.ts` — transient unreadable retry ロジック
- `scripts/tests/workspace-file-search.test.ts` — 回帰テスト追加

## スコープ外

- `docs/design/` の更新（設計文書に影響する仕様変更ではないため不要）
- `.ai_context/` の更新（影響なし）
- `README.md` の更新（ユーザー向け動作変更なし）
- その他コンポーネントへの横展開

## タスク一覧

1. review-0650 指摘調査・影響範囲確認
2. `src-electron/snapshot-ignore.ts` の transient unreadable retry 修正
3. `scripts/tests/workspace-file-search.test.ts` への回帰テスト追加
4. `docs/reviews/` 配下の review ファイル全削除（cleanup）
5. テスト実行・build 確認
6. plan result を更新してクローズ

## 影響ファイル

- `src-electron/snapshot-ignore.ts`
- `scripts/tests/workspace-file-search.test.ts`
- `docs/reviews/` 配下の全 .md ファイル（削除）

## 検証

- `npm run test` / 該当テストファイルのみ実行でも可
- `npm run build` を通す

## docs sync 判断

- `docs/design/` : 更新不要（内部 retry 実装の変更のみ、設計仕様への影響なし）
- `.ai_context/` : 更新不要
- `README.md` : 更新不要（ユーザー向け動作に変化なし）
