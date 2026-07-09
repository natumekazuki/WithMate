# @ プレフィックス ディレクトリ候補対応

## 目的

`@` プレフィックスの添付候補で、ファイルだけでなくディレクトリも候補に出し、候補一覧でファイルとディレクトリを視覚的に区別できるようにする。

## スコープ

- ワークスペース内パス検索の候補型にディレクトリを追加する。
- Renderer 側の候補一覧で種別を表示し、ファイルとディレクトリで色を分ける。
- 既存の添付解決と `.gitignore` 判定を壊さない。
- 必要に応じて設計ドキュメントを更新する。

## 非スコープ

- ワークスペース外ディレクトリの `@` 候補化。
- ディレクトリ添付の中身展開ルール変更。
- ファイルピッカーの挙動変更。

## チェックリスト

- [x] 現行の `@` 候補検索と添付解決の流れを確認する。
- [x] ディレクトリ候補を検索結果に含める。
- [x] UI でファイルとディレクトリを色分けする。
- [x] 回帰テストを追加または更新する。
- [x] build / 対象テストで検証する。
- [x] docs / `.ai_context` の更新要否を確認する。

## 想定変更ファイル

- `src/App.tsx`
- `src/session-components.tsx`
- `src/style.css`
- `src-electron/workspace-file-search.ts`
- `src/workspace-path-candidate.ts`
- `src-electron/main.ts`
- `scripts/tests/workspace-file-search.test.ts`
- `docs/design/desktop-ui.md` または関連 design
