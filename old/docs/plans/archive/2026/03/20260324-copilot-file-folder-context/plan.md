# Plan

## 背景

- `docs/plans/20260322-copilot-capability-rollout/` の次 slice として `file / folder context` が残っている
- composer では `@path` から file / folder / image を共通解決しているが、Copilot adapter は現状すべて未対応で reject している
- Copilot SDK の `MessageOptions.attachments` には `file` / `directory` がある

## 目的

- Copilot session で `@path` 由来の file / folder 添付を provider-native attachment として送れるようにする
- image は scope 外として現状の未対応を維持する

## スコープ

- `ComposerAttachment` から Copilot `MessageOptions.attachments` への変換
- `CopilotAdapter` での send payload 反映
- 必要な docs / manual test / capability matrix 更新
- 最小の自動テスト追加

## スコープ外

- image attachment の Copilot 対応
- UI の新規追加
- attachment chip の見た目変更

## タスク

1. 既存 attachment 解決と Copilot SDK attachment surface を確認する
2. file / folder 専用の attachment 変換を実装する
3. image 添付時の挙動を明示する
4. テストと docs を更新する
5. build / test で確認する
