# Result

## 状態

- 完了

## まとめ

- Copilot SDK では `/tasks` 相当の background task snapshot を `session.idle.backgroundTasks` と `system.notification` から取得できることを確認した
- WithMate では `LiveSessionRunState.backgroundTasks` と Session 右ペインの Copilot 専用 `Tasks` tab を追加し、Copilot の current session に紐づく background task を観測できるようにした
- Codex SDK `@openai/codex-sdk@0.114.0` には同等 surface が見えないため、current task では parity を見送った
- 対応コミット:
  - `f56be64 feat(session): add copilot tasks pane`
