# Decisions

## 2026-03-24

- `Copilot` では `ComposerAttachment.kind === "image"` も `MessageOptions.attachments` の `type: "file"` として送る
- renderer の attachment UI は provider ごとに分岐せず、`Image` ボタンを共通で維持する
