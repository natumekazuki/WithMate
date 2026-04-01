# 2026-04-01 pending elicitation

## 目的

- GitHub issue `#33 handlePendingElicitation` に対応する
- Copilot SDK の `elicitation.requested` / `session.rpc.ui.elicitation` を WithMate の live session UI から扱えるようにする
- approval と混線させず、pending item として独立して扱う

## スコープ

- runtime state に elicitation request / response 型を追加する
- provider runtime / Copilot adapter に elicitation callback を追加する
- main / preload / renderer の IPC 経路を追加する
- Session UI に elicitation card と入力フォームを追加する
- 必要なテストと docs を同期する

## 進め方

1. 既存 approval フローとの差分を整理し、state / service / IPC の境界を定義する
2. Copilot adapter で `elicitation.requested` を捕捉し、UI から `session.rpc.ui.elicitation` を返せるようにする
3. Session UI に schema ベースの入力フォームを追加し、accept / decline / cancel を送れるようにする
4. docs / backlog / checklist を同期し、issue 反映と archive を行う

## 完了条件

- live run 中に elicitation request が state へ出る
- renderer から accept / decline / cancel を返せる
- 応答後に pending state が消える
- 関連テストと設計書が更新されている
