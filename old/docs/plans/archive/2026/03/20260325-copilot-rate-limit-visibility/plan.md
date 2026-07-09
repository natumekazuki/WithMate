# 20260325 copilot-rate-limit-visibility

## Goal

- Issue `#11 レートリミット可視化` の第 1 slice として、Copilot の premium request と context usage を Session UI へ出す
- global な quota 状態と session local な context usage を分離した設計で実装に入れる状態にする

## Scope

- Copilot の `premium requests` 可視化
- Copilot の `context usage` 可視化
- Main Process memory 上の telemetry state / IPC / renderer state 設計
- Session Window の最小 UI 設計

## Out Of Scope

- Codex 側の rate limit / quota 可視化
- DB 永続化
- budget 設定や billing 操作
- Home への detailed usage panel 常設

## UX Assumption

- `Premium Requests` は app 全体で共有される account-level 情報として扱う
- Session Window では `残量` が分かる最小表示だけ常時出せればよい
- `Context Usage` は session ごとの情報として扱い、ユーザー操作で開くまでは UI 領域をほとんど使わない

## Steps

1. `premium requests` の global telemetry state と `context usage` の session telemetry state を定義する
2. Copilot adapter event / RPC から telemetry を更新する main process flow を設計する
3. Session Window の `残量だけ見える常時表示` と `context usage の on-demand 表示` を設計する
4. docs/design と backlog の状態を同期する
