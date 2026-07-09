# Codex Diagnostic Log Cleanup

## Goal

Codex 実行時の一時的な stream 診断ログを通常運用ログから外し、必要時だけ debug flag で再有効化できる状態にする。

## Background

#156 では、Codex SDK stream の `collab_tool_call` lifecycle、Windows `taskkill` parse noise、`turn.completed` 前後の failure 判定を確認するため、stream event level の診断ログを一時的に増やしていた。

添付 JSONL の分析では、全 3,200 行のうち 2,704 行が Codex stream 診断ログだった。

| kind | count |
| --- | ---: |
| `codex.run.stream.event` | 2,360 |
| `codex.run.stream.opened` | 174 |
| `codex.run.stream.finished` | 170 |
| total | 2,704 |

これは全体の 84.5% であり、通常運用ログとしては多すぎる。

## Findings

### collab_tool_call lifecycle

添付ログでは `spawn_agent` / `wait` / `close_agent` の started / completed が揃っていた。

| tool | started | completed |
| --- | ---: | ---: |
| `spawn_agent` | 35 | 35 |
| `wait` | 30 | 30 |
| `close_agent` | 15 | 15 |

#156 の「collab_tool_call lifecycle を実ログで確認する」目的は達成済みと判断する。

### Windows taskkill parse noise

添付ログでは `taskkill` / `parse-noise` / `codex.run.parse-noise.ignored` は 0 件だった。

そのため、#156 を閉じる理由として「taskkill parse noise の本番実例を確認した」とは書かない。parse-noise 境界は既存 test と summary log で維持し、event-level stream log を通常運用に常設する理由にはしない。

### failure / error summary

通常運用に残す必要があるのは、event 全件ではなく turn summary である。

- usage limit は `streamErrorMessage` と `providerErrorReason=usage_limit` で追える。
- user cancel / abort は `aborted`、`canceledMessage`、`providerErrorReason=canceled` で追える。
- provider error / stream error は `codex.run.provider-error` と `codex.run.stream-error` に summary を残す。
- `turnCompleted`、`hasUsage`、`itemCount`、`liveStepCount` は completed / failed / provider-error の summary に残す。

## Decision

通常運用では summary log だけを出す。

通常ログに残す:

- `codex.run.started`
- `codex.run.completed`
- `codex.run.failed`
- `codex.run.provider-error`
- `codex.run.stream-error`
- `codex.run.parse-noise.ignored`

通常ログから外す:

- `codex.run.stream.opened`
- `codex.run.stream.event`
- `codex.run.stream.finished`

必要時だけ、次の debug flag で stream 診断ログを再有効化する。

```text
WITHMATE_CODEX_STREAM_DEBUG=1
```

debug flag 有効時は、`stream.opened` / `stream.event` / `stream.finished` を従来どおり出す。

## Implementation Scope

- `src-electron/codex-adapter.ts`
  - `WITHMATE_CODEX_STREAM_DEBUG` を読み、stream 詳細ログ 3 種だけを gate する。
  - completed / failed / provider-error / stream-error の summary は維持する。
- `scripts/tests/codex-adapter.test.ts`
  - 通常時に stream 診断ログが出ないことを検証する。
  - debug flag 有効時に `collab_tool_call` lifecycle の詳細ログが出ることを検証する。

## Done Criteria

- 通常運用で `codex.run.stream.event` が大量に出ない。
- `codex.run.completed` / `codex.run.failed` の summary は残る。
- usage limit / cancel / provider error / stream error の原因分析に必要な summary は残る。
- 必要時は `WITHMATE_CODEX_STREAM_DEBUG=1` で stream event を再有効化できる。
- CodexAdapter 関連 test が通る。

## Validation

```bash
node --import tsx --test scripts/tests/codex-adapter.test.ts
npm run typecheck
npm test
```

## Follow-up

添付ログでは `ipc.error` が 83 件あり、すべて `withmate:list-session-skills` の `対象セッションが見つからないよ。` だった。これは #156 の対象外だが、stream 診断ログ整理後に次のログ騒音として目立つ可能性がある。
