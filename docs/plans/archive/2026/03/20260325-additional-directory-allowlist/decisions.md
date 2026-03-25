# Decisions

## 2026-03-25

- 正本は `Session.allowedAdditionalDirectories` とする
- workspace 外 path は、許可済み追加ディレクトリ配下でない限り `ComposerPreview.errors` にする
- Codex の `additionalDirectories` は添付から自動導出せず、session metadata から渡す
- Copilot は provider-native allowlist を触らず、WithMate 側の添付制御と監視対象だけを共通で持つ
- `Remove` は Codex のときだけ UI に出す
