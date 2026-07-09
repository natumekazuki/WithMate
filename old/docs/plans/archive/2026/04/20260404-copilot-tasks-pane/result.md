# Result

- 状態: 完了
- Copilot session の background task snapshot を `Latest Command` から独立した `Tasks` tab へ移した
- `Tasks` tab は Copilot session でだけ有効化し、non-Copilot session では cycle と auto-switch 対象から外した
- `Tasks` は current SDK surface に合わせて `running / completed / failed` の coarse snapshot 表示に留めた
- 対応コミット:
  - `f56be64 feat(session): add copilot tasks pane`
- 検証:
  - `node --import tsx scripts/tests/session-ui-projection.test.ts`
  - `node --import tsx scripts/tests/session-app-render.test.ts`
  - `npm run build`
