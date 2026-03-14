# Goal
GitHub Desktop ライクな split diff 閲覧を WithMate の `Session Window` に実装する。新規作成・更新・削除のすべてで `Before / After` を閲覧できる状態まで仕上げる。

# Task List
- [x] diff 取得方針を設計ドキュメントへ明記する
- [x] `CodexAdapter` で `file_change` ごとの `before / after` スナップショット取得を実装する
- [x] `ChangedFile.diffRows` を `add / edit / delete` すべてで生成する
- [x] `Session Window` の diff viewer を GitHub Desktop ライクな閲覧体験に合わせて調整する
- [x] 関連 docs を current 実装へ更新する
- [x] `npm run typecheck` / `npm run build` / `npm run build:electron` を通す

# Affected Files
- `src-electron/codex-adapter.ts`
- `src/mock-data.ts`
- `src/App.tsx`
- `src/styles.css`
- `docs/design/provider-adapter.md`
- `docs/design/ui-react-mock.md`
- `docs/design/product-direction.md`
- `docs/plans/20260314-github-desktop-like-diff.md`

# Risks
- Codex SDK の `file_change` だけでは差分本文が取得できないため、workspace 上の `before / after` を補完取得する必要がある
- Git 管理されていない workspace や untracked file が混在するため、`git diff` 依存だけでは不十分
- 実行後にファイルを直接読み直す方式だと、将来 streaming diff へ移る際に別設計が必要になる

# Design Check
- `docs/design/provider-adapter.md` の更新が必要
- `docs/design/ui-react-mock.md` の更新が必要
- diff 取得ルールが増えるため、`docs/design/product-direction.md` の current behavior も確認する

# Proposed Approach
- `add`: 実行後ファイル本文を `after` として読み、`before` は空で rows を作る
- `delete`: 実行前スナップショットを `before` として保持し、`after` は空で rows を作る
- `edit`: 実行前スナップショットと実行後ファイル本文を比較して split rows を作る
- 実行前スナップショットは `runSessionTurn()` 開始時に対象ファイル群を保存し、artifact 生成時に使う

# Notes / Logs
- `file_change` 自体には diff 本文が来ないため、Main Process 側で workspace snapshot を取る方式にした。
- snapshot は `node_modules` や `.git` などを除外した text file のみを対象にする。
- 行差分は LCS ベースで組み立て、連続する `delete/add` を `modify` へ寄せて side-by-side 表示に使う。
