# 20260404-session-markdown-fix worklog

## 2026-04-04

- repo plan を作成
- issue `#23` の現状確認を開始
- `src/MessageRichText.tsx` の inline parser を scanner 化し、`code / link / bold` を順に解釈するよう変更
- `scripts/tests/message-rich-text.test.ts` を追加し、`**bold**` と `code + link + bold` の併用を固定
- `docs/design/message-rich-text.md` に `**strong**` 対応を追記
- `docs/task-backlog.md` の `#23` を進行中へ更新
- `.ai_context/` と `README.md` は今回の renderer 修正では更新不要と判断
- `node --import tsx scripts/tests/message-rich-text.test.ts`
- `npm run build`
- commit: `ba4b35f` `fix(session): refine rich text and density`
