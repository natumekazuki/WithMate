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
    appSettings: AppSettings;
    attachments: ComposerAttachment[];
  }, onProgress?: (state: LiveSessionRunState) => Promise<void>): Promise<ProviderTurnResult>;
};
```

```ts
type ProviderTurnResult = {
  threadId: string | null;
  assistantText: string;
  artifact?: MessageArtifact;
  systemPromptText: string;
  inputPromptText: string;
  composedPromptText: string;
  operations: AuditLogOperation[];
  rawItemsJson: string;
  usage: AuditLogUsage | null;
};
```

監査用途では、provider 実行結果から `system / input / composed prompt`、operations、raw items、usage も Main Process へ返し、SQLite の監査ログに保存する。

## Session Flow

1. Renderer が `runSessionTurn(sessionId, { userMessage, pickerAttachments })` を IPC で Main Process に送る
2. Main Process が session store から session metadata を引く
3. `characterId` で `CharacterProfile` を読む
4. Main Process が `@path` と picker 添付を解決し、file / folder / image を正規化する
5. Main Process が app settings から `System Prompt Prefix` を読む
6. prompt composer が `# System Prompt + (system prompt prefix + roleMarkdown) + # User Input Prompt + userMessage` を空行区切りで合成する
7. Main Process が session の `catalogRevision` と `provider` から provider catalog を解決する
8. `CodexAdapter` が `model / reasoningEffort` を検証し、通常 file/folder は `additionalDirectories` とワーキングディレクトリ、画像は structured input で SDK の `thread.runStreamed()` を実行する
9. Main Process が stream event から live state を組み立て、IPC で Session Window へ中継する
10. turn 完了後に Main Process が `threadId` と assistant message を session store に反映する
11. Main Process が `started / completed / failed` の監査ログを SQLite に保存する
12. Renderer は `sessions-changed` と live state 購読を使って再描画する

## Prompt Composition Constraint

現時点の Codex SDK には、通常ファイルの専用添付 API はない。画像だけ `local_image` がある。
そのため MVP では adapter 側で次のように分離する。

- file / folder: `additionalDirectories`
- image: structured input (`local_image`)

text prompt 側には `# System Prompt` と `# User Input Prompt` を自動付与し、各レイヤーを空行区切りで結合する。

詳細は `docs/design/prompt-composition.md` を参照する。

## Thread Management

- session ごとに 1 つの Codex thread を持つ
- session に `threadId` がある場合は `resumeThread(threadId)` を使う
- ない場合は `startThread()` で新規作成する
- 実行後に `thread.id` を session store へ保存する
- model または reasoning depth を変更した場合は、その session の `threadId` を空に戻し、次回 turn は新規 thread で開始する

理由:
- Codex thread は作成時の model と結びつくため、既存 thread を別 model で `resumeThread()` すると provider 側で拒否されることがある
- そのため model / reasoning 変更は「同一 session 内での thread 切り替え」として扱う

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

MVP では Codex SDK の `turn.items` と workspace snapshot 差分から最小の summary を組み立てる。

- `file_change` + snapshot diff -> changed files
- `command_execution` -> activity summary
- `mcp_tool_call` / `web_search` / `todo_list` / `reasoning` -> activity summary
- usage -> run checks
- model / reasoning -> run checks

diff 本文は turn items からは直接取れないため、MVP では Main Process 側で `before / after` スナップショットを補完取得する。
`file_change` が返らない `command_execution` ベースの変更も、snapshot 差分から `Changed Files` へ補完する。

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

## Streaming Policy

- provider 実行は `runStreamed()` を使い、turn 完了前の一時状態を Renderer へ中継する
- live state には少なくとも次を含める
  - 最新の assistant text
  - 実行中 / 完了 / 失敗の step 一覧
  - usage
  - stream 中の error
- live state は Main Process の memory 上だけに持ち、session DB へは保存しない
- Session Window を開き直した場合は、Main Process が保持している live state を再購読して復元する
- turn 完了時だけ session 本体と audit log を確定値で更新する

## Error Handling

- provider 実行失敗時は Main Process が session を `runState=error` へ更新する
- Renderer に raw stack trace は出さず、UI 向けの失敗メッセージへ整形する
- thread id が取得済みなら失敗時も保持する
- 失敗時は監査ログにも `phase=failed` を記録し、`system / input / composed prompt` と error を残す

## Audit Logging

- prompt composer が作った `system / input / composed prompt` を監査ログへ保存する
- 画像添付がある場合の `composed prompt` は text 部分のみで、画像 payload は別送される
- `turn.items` は読みやすい `operations` と raw の `raw_items_json` の両方で残す
- Session Window から監査ログを overlay で閲覧できるようにする
- stream 中の一時 step は監査ログへ逐次保存せず、turn 完了後の確定値だけを残す

## Future Extension

将来は次を追加できる構造にする。

- `CopilotAdapter`
- provider ごとの prompt composer 差し替え
- artifact summary の richer な構造化

## References

- `docs/design/prompt-composition.md`
- `docs/design/session-persistence.md`
- `docs/design/model-catalog.md`
- `docs/design/audit-log.md`
