# Codex Usage Limit Error Classification

## Goal

Codex の使用上限到達を通常の provider failure と分け、runtime / audit / UI で内部クラッシュのように見えない状態にする。

## Background

Codex 使用上限到達時、現在は通常の `codex.run.failed` として扱われる。確認済みログでは、SDK が投げる最終 error message は汎用的でも、stream event 側の `streamErrorMessage` には使用上限到達が明確に含まれていた。

```text
kind: codex.run.failed
level: error
streamErrorMessage: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jun 12th, 2026 2:07 AM.
error.message: Codex Exec exited with code 1: Reading prompt from stdin...
```

該当ログでは次の順で記録されていた。

- `codex.run.stream.event` / `eventType=error`
- `codex.run.stream.event` / `eventType=turn.failed`
- `codex.run.failed`

## Design

Provider failure の分類は `ProviderTurnError` の契約に `reason` として持たせる。分類判定そのものは provider 固有 helper に閉じ、`SessionRuntimeService` が Codex 固有の英語 message を再 parse しないようにする。

```ts
type ProviderErrorReason =
  | "usage_limit"
  | "auth"
  | "network"
  | "provider_unavailable"
  | "canceled"
  | "unknown";
```

`canceled` は既存の session phase / retry / invalidation 判定に使われているため、boolean として維持する。`reason` は追加情報として扱い、既存 constructor 呼び出しには `unknown` / `canceled` の default を与える。

Codex usage-limit 判定は保守的な文字列判定にする。

- `You've hit your usage limit.`
- `purchase more credits`
- `try again at`

SDK が wrapper error を投げる場合でも、stream event の `streamErrorMessage` に usage-limit message が残っていれば `usage_limit` として扱う。

## User Facing Message

使用上限到達時は通常の `実行に失敗したよ。` ではなく、次の形式で表示・保存する。

```text
Codexの使用上限に達しました。
再実行可能時刻: Jun 12th, 2026 2:07 AM
```

再実行可能時刻を抽出できない場合は、元 message の短い preview を詳細として残す。

## Scope

- `src-electron/provider-runtime.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/session-runtime-service.ts`
- `scripts/tests/codex-adapter.test.ts`
- `scripts/tests/session-runtime-service.test.ts`

## Done

- 使用上限到達が `ProviderTurnError.reason === "usage_limit"` として分類される。
- 通常 provider failure、user cancel、既存の Windows taskkill parse-noise 境界と区別される。
- audit log / assistant fallback message が内部クラッシュのような汎用失敗文言だけにならない。
- Codex adapter と session runtime の targeted tests が通る。

## Validation

```bash
node --import tsx --test scripts/tests/codex-adapter.test.ts
node --import tsx --test scripts/tests/session-runtime-service.test.ts
npm run typecheck
```
