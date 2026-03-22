# Decisions

## 2026-03-22

### 最初は `1 turn 実行` だけを通す

- Copilot 対応を一気に広げると、approval、resume、artifact、command visibility が同時に崩れる
- 今回は `基本 turn 実行` slice に絞り、prompt を送り assistant response を session に保存できるところまでを完了条件にする

### approval は暫定実装に留める

- `onPermissionRequest` は Copilot SDK で必須
- ただし current rollout では approval mode の厳密 mapping は次 slice
- そのため今回は最小 turn 実行を成立させる暫定 handler を置き、後続 task で精密化する

### audit / artifact は最小値でよい

- current audit log は Codex item schema 前提が強い
- まずは `prompt / assistantText / provider metadata / error` が残るだけでも良い
- operation timeline や changed files は空で構わない

### 添付はこの slice では明示的に止める

- Copilot SDK native には file / directory attachment がある
- ただし current task で同時に繋ぐと `@path` 解決、Audit Log、Diff、manual test が一気に広がる
- 今回は text-only turn と live text streaming を先に通し、添付は follow-up capability として切り出す
