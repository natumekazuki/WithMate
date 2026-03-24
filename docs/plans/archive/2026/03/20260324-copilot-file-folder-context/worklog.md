# Worklog

## 2026-03-24

- 起票: Copilot の file / folder context 実装を開始
- Copilot SDK の `MessageOptions.attachments` に `file` / `directory` があることを local type / README で確認した
- `src-electron/copilot-adapter.ts` で file / folder を Copilot attachment へ変換し、`session.send({ attachments })` に載せる実装を追加した
- image は scope 外として `Copilot provider の image 添付はまだ未対応` エラーへ寄せた
- `scripts/tests/copilot-adapter.test.ts` に attachment 変換テストを追加し、`node --import tsx scripts/tests/copilot-adapter.test.ts` と `npm run build` で確認した
