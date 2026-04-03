# Decisions

## 現在の判断

### 1. `/tasks` は Copilot-only の snapshot 実装に留める

- Copilot SDK `@github/copilot-sdk@0.2.0` では `session.idle.backgroundTasks` と `system.notification` から background task 情報を読める
- current scope では dedicated `/tasks` window や control UI は作らず、Session 右ペイン `Latest Command` 配下の `Tasks` card へ表示する

### 2. Codex parity は current task では見送る

- `@openai/codex-sdk@0.114.0` の public surface では background task 相当の event / list API を確認できない
- capability matrix と SDK pending doc に `Codex 非対応` として記録し、無理に provider-neutral UI へ広げない
