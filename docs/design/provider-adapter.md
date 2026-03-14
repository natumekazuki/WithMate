# Provider Adapter

- 作成日: 2026-03-13
- 対象: WithMate の Main Process に置く provider 実行境界

## Goal

Renderer が provider ごとの差異を知らずに、`Session Window` の送信と結果反映を扱えるようにする。

## Boundary

WithMate では provider 実行境界を Main Process に置く。

理由:
- CLI ログイン状態を安全に引き継ぎやすい
- Electron Renderer へ SDK 実行権限を持ち込まなくてよい
- session store と thread id を同じ責務で管理できる

## Current MVP

MVP では `CodexAdapter` を 1 実装だけ持つ。

```ts
type ProviderAdapter = {
  runSessionTurn(input: {
    session: Session;
    character: CharacterProfile;
    userMessage: string;
  }): Promise<ProviderTurnResult>;
};
```

```ts
type ProviderTurnResult = {
  threadId: string | null;
  assistantText: string;
  artifact?: MessageArtifact;
};
```

## Session Flow

1. Renderer が `runSessionTurn(sessionId, userMessage)` を IPC で Main Process に送る
2. Main Process が session store から session metadata を引く
3. `characterId` で `CharacterProfile` を読む
4. prompt composer が `fixed system prompt + roleMarkdown + session context + userMessage` を合成する
5. Main Process が session の `catalogRevision` と `provider` から provider catalog を解決する
6. `CodexAdapter` が `model / reasoningEffort` を解決して SDK の `thread.run()` を実行する
7. Main Process が `threadId` と assistant message を session store に反映する
8. Renderer は `sessions-changed` を購読して再描画する

## Prompt Composition Constraint

現時点の Codex SDK には、turn ごとに明示的な `system prompt` を渡す専用 API がない。
そのため MVP では adapter 側で 1 本の composed prompt を作り、`thread.run()` に渡す。

詳細は `docs/design/prompt-composition.md` を参照する。

## Thread Management

- session ごとに 1 つの Codex thread を持つ
- session に `threadId` がある場合は `resumeThread(threadId)` を使う
- ない場合は `startThread()` で新規作成する
- 実行後に `thread.id` を session store へ保存する

## Session Metadata Dependency

adapter 実行に最低限必要な session 情報:

- `session.id`
- `session.workspacePath`
- `session.catalogRevision`
- `session.provider`
- `session.approvalMode`
- `session.model`
- `session.reasoningEffort`
- `session.characterId`
- `session.threadId`

## Model Resolution Policy

- session metadata には user selection として `provider / model / reasoningEffort / catalogRevision` を保存する
- adapter 実行時に session が参照している catalog revision を使って `provider / model / reasoningEffort` を検証する
- model 自体が見つからない場合はそのままエラーにする
- selected depth が非対応ならそのままエラーにする
- provider 実行時に拒否された場合も、そのまま session error として扱う

詳細は `docs/design/model-catalog.md` を参照する。

## Artifact Summary Policy

MVP では Codex SDK の `turn.items` から最小の summary を組み立てる。

- `file_change` -> changed files
- `command_execution` -> activity summary
- `mcp_tool_call` / `web_search` / `todo_list` / `reasoning` -> activity summary
- usage -> run checks
- model / reasoning -> run checks

diff 本文は turn items からは直接取れないため、MVP では Main Process 側で `before / after` スナップショットを補完取得する。

- 実行前に workspace 全体の text file snapshot を取る
- snapshot の除外判定は、workspace から親方向へ探索した `.gitignore` を使う
- `.git` は `.gitignore` に関係なく常に除外する
- Git 管理下なら Git root までの `.gitignore` を上から順に積む
- Git 管理下なら `.git/info/exclude` も Git root 基準の ignore source として使う
- Git 管理下でない場合は、workspace 直下と最初に見つかった親の `.gitignore` までを使う
- workspace 配下で見つかった nested `.gitignore` は、そのディレクトリ以下にだけ適用する
- snapshot は 1 file あたり 1 MiB、全体で 4,000 files / 16 MiB を上限にする
- `add`: `before = null`, `after = 実行後本文`
- `edit`: `before = 実行前 snapshot`, `after = 実行後本文`
- `delete`: `before = 実行前 snapshot`, `after = null`
- `ChangedFile.diffRows` は split diff viewer 向けに `add / edit / delete / modify / context` を持つ

この方式は GitHub Desktop ライクな side-by-side diff を優先した MVP であり、将来 streaming diff を導入する場合は取得経路を見直す。
さらに `.gitignore` の優先順や exclude source を厳密に Git 本体へ寄せたくなったら、その時点で拡張する。

## Error Handling

- provider 実行失敗時は Main Process が session を `runState=error` へ更新する
- Renderer に raw stack trace は出さず、UI 向けの失敗メッセージへ整形する
- thread id が取得済みなら失敗時も保持する

## Future Extension

将来は次を追加できる構造にする。

- `CopilotAdapter`
- `runStreamed()` ベースのリアルタイム更新
- provider ごとの prompt composer 差し替え
- artifact summary の richer な構造化

## References

- `docs/design/prompt-composition.md`
- `docs/design/session-persistence.md`
- `docs/design/model-catalog.md`
