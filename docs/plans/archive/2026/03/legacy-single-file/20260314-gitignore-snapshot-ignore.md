# Goal
Diff 用 workspace snapshot の除外判定を固定ディレクトリ一覧ではなく `.gitignore` ベースに切り替える。

# Task List
- [x] `.gitignore` 読み込み方針を決める
- [x] `codex-adapter` の snapshot 除外判定を `.gitignore` ベースへ切り替える
- [x] 固定除外ルールは `.git` など最低限だけに絞る
- [x] 関連 design docs を更新する
- [x] `npm run typecheck` / `npm run build` / `npm run build:electron` を通す

# Affected Files
- `src-electron/codex-adapter.ts`
- `package.json`
- `docs/design/provider-adapter.md`
- `docs/plans/20260314-gitignore-snapshot-ignore.md`

# Risks
- `.gitignore` のパターン解釈を雑に実装すると、snapshot 対象漏れや過剰除外が起きる
- workspace 配下にネストした `.gitignore` までは今回扱わない可能性がある
- 依存追加が必要な場合は Electron build への影響確認が必要

# Design Check
- `docs/design/provider-adapter.md` の更新が必要

# Notes
- まずは workspace root の `.gitignore` を正本にする
- `.git` は `.gitignore` に関係なく常に除外する
- `ignore` ライブラリを追加して `.gitignore` の glob 解釈を委譲する
- Git 管理下なら Git root まで親方向に `.gitignore` を探索して積む
- Git 管理下でない場合は、workspace 直下と最初に見つかった親の `.gitignore` までを見る
- Git 管理下なら `.git/info/exclude` も読む
- workspace 配下の nested `.gitignore` も、その配下に入るときに追加適用する

- 2026-03-14: 
pm run typecheck / 
pm run build / 
pm run build:electron を実行し、通過を確認した。

- 2026-03-14: workspace の親方向へ .gitignore を探索するように拡張し、Git 管理下では Git root までのルールを積むようにした。

- 2026-03-14: nested .gitignore と .git/info/exclude を読み、base directory ごとの matcher を順に評価する方式へ変更した。
