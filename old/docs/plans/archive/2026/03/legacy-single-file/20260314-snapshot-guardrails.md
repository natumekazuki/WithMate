# Goal
Diff snapshot の ignore 判定を検証できるようにしつつ、snapshot のファイル数 / 総サイズに上限を入れてメモリと処理時間を抑える。

# Task List
- [x] snapshot ignore / traversal ロジックを共通 utility へ切り出す
- [x] `git check-ignore` と比較する検証スクリプトを追加する
- [x] snapshot のファイル数 / 総サイズ上限を実装する
- [x] 関連 design docs と plan を更新する
- [x] `npm run typecheck` / `npm run build` / `npm run build:electron` / 検証スクリプトを通す

# Affected Files
- `src-electron/snapshot-ignore.ts`
- `src-electron/codex-adapter.ts`
- `scripts/validate-snapshot-ignore.ts`
- `package.json`
- `docs/design/provider-adapter.md`
- `docs/plans/20260314-snapshot-guardrails.md`

# Risks
- utility 抽出時に current ignore 判定の順序が変わると、既存動作が崩れる
- snapshot 上限を厳しすぎる値にすると、diff rows が取れないファイルが増える
- `git check-ignore` 比較は Git 管理下前提なので、非 Git workspace ではそのまま使えない

# Design Check
- `docs/design/provider-adapter.md` の更新が必要

# Notes
- 上限値は実装で固定し、後から設定化できる形にする
- 検証スクリプトは repo root か任意の subdir を受け取れるようにする
- 上限は `1 MiB / file`, `4,000 files`, `16 MiB total` にした
- 2026-03-14: snapshot 上限は 1 MiB / file, 4,000 files, 16 MiB total に固定した。

- 2026-03-14: 
pm run validate:snapshot-ignore を repo root で実行し、git check-ignore と一致することを確認した。
