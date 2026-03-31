# Plan

## Goal

- stale thread / session 起因エラーに対して、最小安全版の自動 reset + 1 回 internal retry を入れる
- same-plan には `stale-thread classifier + internal retry` と、`model / reasoningEffort` change 時の pre-send reset を含める

## Scope

- `SessionRuntimeService` 内で stale thread / session 起因エラーを分類し、同一 user turn に 1 回だけ internal retry する
- DB 側は `threadId` 自体の reset では壊れにくい前提で進めるが、`threadId` クリアだけでは不十分で provider cache invalidate まで行う
- retry 条件は `partial result 実質なし` を必須にし、途中結果がある失敗には適用しない
- `model / reasoningEffort` change 時は send 前に reset し、stale / incompatible な thread reuse を避ける
- Copilot の既存 stale connection retry は維持し、今回の same-plan では一般 transport error へ広げない

## Out Of Scope

- transport error 一般化
- partial result 後 retry
- public API retry

## same-plan / new-plan 境界

### same-plan

- stale-thread classifier の追加
- `SessionRuntimeService` 内の 1 回だけ internal retry
- `model / reasoningEffort` change 時の pre-send reset
- retry 前に必要な provider cache invalidate

### new-plan / follow-up

- transport error 全般をまとめて扱う retry taxonomy
- partial result が出た後の retry / recover policy
- renderer / public API から見える retry 制御や外部化

## Acceptance

- stale thread / session 起因と判断できる失敗だけが internal retry 対象になる
- retry は `SessionRuntimeService` 内で同一 user turn に 1 回だけで、無限再試行にならない
- `partial result 実質なし` のときだけ retry される
- `threadId` reset 時に provider cache も invalidate され、古い session / thread を掴み直さない
- `model / reasoningEffort` change 時の pre-send reset が same-plan に含まれている
- Copilot 既存 stale connection retry は壊さず、一般 transport error には拡張しない

## Risks

- stale 判定を広げすぎると、本来 user に見せるべき provider error まで retry してしまう
- `threadId` だけ消して provider cache を残すと、同じ stale state を再利用して再発する
- `partial result 実質なし` の判定が甘いと、既に見えた応答を失う可能性がある
