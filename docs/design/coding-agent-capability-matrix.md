# Coding Agent Capability Matrix

## Goal

- WithMate が wrapper として扱う coding agent capability を 1 枚で追跡できるようにする
- capability ごとに `Codex`、`GitHub Copilot CLI`、`WithMate current` の対応状況を同じ表で確認できるようにする
- 今後の実装や改修で、何を更新すべきかの正本 doc とする

## Position

- cross-provider capability 一覧の正本はこの文書とする
- provider 実行境界そのものの仕様は `docs/design/provider-adapter.md` を正本とする
- provider 個別の詳細 snapshot は `docs/design/codex-capability-matrix.md` などの supporting doc を参照する

## How To Use

- 行は `WithMate が canonical UI / metadata として持ちたい capability` を表す
- `Codex` 列と `GitHub Copilot CLI` 列は、provider native にどこまで対応余地があるかを示す
- `WithMate current` 列は、今の wrapper 実装がどこまで吸収できているかを示す
- 新しい実装や仕様変更を入れたら、この doc を同じ task で更新する
- provider native 挙動が docs だけでは確定しない場合は、推測で埋めず `未確認` にする

## Status Vocabulary

### Provider Native

- `対応`
- `一部対応`
- `未確認`
- `非対応`

### WithMate Current

- `実装済み`
- `一部実装`
- `設計済み`
- `未着手`

## Capability Matrix

| Capability | WithMate canonical shape | Codex | GitHub Copilot CLI | WithMate current | Notes |
| --- | --- | --- | --- | --- | --- |
| 基本 turn 実行 | session から prompt を送って assistant response を得る | 対応 | 対応 | 実装済み | current runtime は Codex と Copilot の両 adapter を持つ。Copilot は text-only の minimal turn から開始 |
| session 再開 | session metadata と provider thread/session id を結びつけて継続する | 対応 | 対応 | 実装済み | Codex は `threadId` を保持して `resumeThread()`、Copilot も `sessionId` を `threadId` として保存し `resumeSession()` する |
| cancel / interrupted handling | 実行中 turn を止め、UI と audit に canceled/interrupted を残す | 対応 | 未確認 | 実装済み | Copilot 側の中断 surface は別途実測が必要 |
| retry | canceled/error 後に同じ request を再送する | 対応 | 未確認 | 実装済み | provider native 機能というより wrapper UX |
| model selection | session ごとに model を選ぶ | 対応 | 対応 | 実装済み | catalog と session metadata に保存 |
| reasoning depth | session ごとに reasoning depth を選ぶ | 対応 | 未確認 | 実装済み | Copilot 側の depth 同等概念は未整理 |
| approval mode | provider-native approval 設定へ map する | 対応 | 一部対応 | 一部実装 | WithMate は `allow-all / safety / provider-controlled` を正本にしている。Copilot `provider-controlled` は direct approval UI と接続したが、Codex は policy mapping のまま |
| file / folder context | workspace file/folder を turn input に含める | 一部対応 | 一部対応 | 実装済み | workspace 外 path は session metadata `allowedAdditionalDirectories` 配下だけを許可する。Codex はその許可リストを `additionalDirectories`、Copilot は `attachments` の `file` / `directory` へ変換して送る |
| image attachment | image を turn input に含める | 対応 | 一部対応 | 実装済み | Codex は `local_image`、Copilot は `attachments` の `file` として送る |
| skill selection | skill を選び、provider native invocation へ変換する | 対応 | 対応 | 実装済み | Codex は `$skill-name`、Copilot は directive 設計まで |
| custom agent selection | provider 固有 agent を session metadata へ反映する | 一部対応 | 対応 | 実装済み | Codex の `/agent` は thread switch 寄りで意味が違う。Copilot は `~/.copilot/agents` と workspace `.github/agents` を探索し、session metadata の選択値を `customAgents` / `agent` へ変換する |
| assistant text streaming | turn 完了前の message stream を UI に出す | 対応 | 対応 | 実装済み | Codex は `runStreamed()`、Copilot は `assistant.message_delta` を live state へ中継し、top-level `assistant.message` が複数回来た場合も空行区切りで連結する |
| command visibility | 実行中または直前 command を UI で確認できる | 対応 | 一部対応 | 実装済み | Session 右 pane の `Latest Command`。Copilot は shell に加えて `create / edit / replace / move / delete` などの mutating tool も `command_execution` へ正規化して表示する |
| live step timeline | command 以外の進行 step も細かく可視化する | 対応 | 未確認 | 一部実装 | 現在は情報量を絞って `Latest Command` 優先 |
| audit log | prompt / operations / raw items / usage を保存する | 対応 | 一部対応 | 実装済み | Codex は rich item schema、Copilot は prompt / assistant / stable provider event trace / normalized operations を保存する |
| changed files / diff | 変更ファイルと diff を見せる | 一部対応 | 未確認 | 実装済み | current は snapshot diff fallback 前提。監視対象は `workspacePath + allowedAdditionalDirectories`。Copilot でも snapshot diff から `artifact.changedFiles` を組み立て、`Details` と `Open Diff` を出す |
| partial result preservation | canceled/failed 時も取得済み text/items を残す | 対応 | 未確認 | 実装済み | current runtime は Codex partial result を保存 |
| slash command absorption | provider slash command を canonical UI/metadata に吸収する | 一部対応 | 一部対応 | 設計済み | docs はあるが parser 実装は未着手 |
| native slash passthrough | provider slash command を SDK 経由でそのまま実行する | 非対応 | 非対応 | 未着手 | SDK surface 上は想定しない方針 |
| apps / mcp / plugins | provider 拡張機能を session から扱う | 一部対応 | 一部対応 | 未着手 | Codex は `/apps` `/mcp`、Copilot は plugin 系がある |
| sandbox / allowlist 拡張 | read dir 追加や tool allowlist を wrapper から制御する | 一部対応 | 一部対応 | 未着手 | approval mode より細かい native control は未吸収 |
| app-level approval callback | app 側で approve / deny を返す | 非対応 | 一部対応 | 一部実装 | Copilot provider-controlled では Session UI の approval card から `approve / deny` を返せる。Codex は current SDK surface では未対応 |

## Current Read

2026-03-22 時点では、WithMate の Codex 対応は日常利用に足る範囲まで入っている。  
一方で cross-provider matrix として見ると、未着手が多いのは `Copilot runtime`, `approval detail`, `slash command`, `agent/apps/mcp/plugins` まわり。

## Update Rule

- capability の status を変える change では、この doc を同じ plan / commit 系列で更新する
- provider native support を更新するときは、関連調査 doc か公式 docs を notes または related docs に残す
- `WithMate current` は「docs があるか」ではなく「main branch で動く実装があるか」で判定する
- provider ごとの詳細差分が増えたら、この doc は概要だけを残し、詳細は個別 doc へ分割する

## Related Docs

- `docs/design/provider-adapter.md`
- `docs/design/codex-capability-matrix.md`
- `docs/design/codex-approval-research.md`
- `docs/design/slash-command-integration.md`
- `docs/design/skill-command-design.md`
