# Result

- status: completed
- summary:
  - Codex SDK には `ThreadOptions.additionalDirectories?: string[]` があり、追加ディレクトリを thread 設定へ渡す surface 自体は存在する
  - WithMate current でも `src-electron/codex-adapter.ts` が workspace 外 `file / folder` 添付から `additionalDirectories` を組み立てている
  - ただし current の changed files / diff 追跡は `captureWorkspaceSnapshot(session.workspacePath)` の before / after 比較だけなので、追加ディレクトリ配下の変更は artifact に出ない
  - したがって Issue `#13` のうち Codex 側で今できるのは「追加 dir を読ませる / 作業対象に含める」までで、「追加 dir の変更追跡」は未実装

## Findings

1. SDK surface
   - local install の `node_modules/@openai/codex-sdk/dist/index.d.ts` には `ThreadOptions.additionalDirectories?: string[]` がある
   - 追加 dir の専用 RPC や、turn 実行中に後付けする API は見当たらない
   - SDK 上の naming は `additionalDirectories` で、CLI 的には `/sandbox-add-read-dir` に近い概念として見える

2. WithMate current
   - `src-electron/provider-prompt.ts` は file / folder を prompt text へ埋め込まず、実行設定側へ寄せる
   - `src-electron/codex-adapter.ts` は workspace 外の file / folder 添付から親 directory を抽出し、`startThread()` / `resumeThread()` の `additionalDirectories` に渡している
   - つまり「外部 dir を Codex に見せる」機能自体は、すでに限定的に入っている

3. 追跡できていない点
   - `src-electron/codex-adapter.ts` の before / after snapshot はどちらも `captureWorkspaceSnapshot(input.session.workspacePath)` 固定
   - `src-electron/snapshot-ignore.ts` も単一 root directory を前提に scan する
   - そのため、追加 dir 配下で file change が起きても `artifact.changedFiles` や diff viewer に載らない

## Recommendation

- Codex 側の次 slice は `additionalDirectories` 自体の新規追加ではなく、次の 2 段階で切るのが自然
  1. Session metadata と UI に「追加 dir」を明示的に持てるようにする
  2. snapshot / diff 基盤を複数 root 対応に広げ、追加 dir の file change も artifact へ出せるようにする

- 注意点:
  - local surface 上は `add-dir = read dir 拡張` に近く、Copilot の `/add-dir` と完全同義にはしない方が安全
  - current SDK surface では、追加 dir を thread 実行中に動的更新するより、thread settings の一部として扱う前提で設計した方が無難

## Evidence

- Issue: `#13 add-dir対応`
- `src-electron/codex-adapter.ts`
- `src-electron/provider-prompt.ts`
- `src-electron/snapshot-ignore.ts`
- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/codex-capability-matrix.md`
- `docs/design/slash-command-integration.md`
- `node_modules/@openai/codex-sdk/dist/index.d.ts`

## Commits

- `e526de2` `docs(backlog): 実装状況の管理列を追加`
