# Decisions

## 2026-03-24

- Copilot には `session.send({ attachments })` を使って file / folder をそのまま渡す
- image は今回の scope 外なので、Copilot では引き続き未対応エラーにする
- `workingDirectory` は session workspace のまま維持し、workspace 外参照も attachment で補う
