# Decisions

## Summary

- approval UI は provider 共通の見た目を持ちつつ、実行 semantics は provider ごとに分けて扱う

## Decision Log

### 0001

- 日時: 2026-03-24
- 論点: Copilot と Codex に同じ approval 実装を要求するか
- 判断: 要求しない。UI contract は揃えるが、provider-native 実装差は保持する
- 理由: Copilot SDK には `onPermissionRequest` callback がある一方、Codex SDK は現状 `approvalPolicy` 設定のみで、app 側 approve / deny callback を持たないため
- 影響範囲: `docs/design/provider-adapter.md`, `docs/design/coding-agent-capability-matrix.md`, `src-electron/copilot-adapter.ts`, `src-electron/codex-adapter.ts`

### 0002

- 日時: 2026-03-24
- 論点: Codex 側に Copilot 風の承認ダイアログを擬装するか
- 判断: 擬装しない。Codex では policy-based retry を明示する
- 理由: 実際には個別 tool 承認ではなく turn 再実行になるため、同一文言で見せると監査と UX の意味がずれるため
- 影響範囲: `docs/design/agent-event-ui.md`, `src/App.tsx`

### 0003

- 日時: 2026-03-24
- 論点: 将来 Codex 側に approval callback が追加された場合に備えて、今どこまで共通 state を切るか
- 判断: renderer には `approval request card` 相当の共通 view model を置き、action 種別を `direct-decision` と `retry-with-policy-change` に分ける
- 理由: UI の骨格を共通化しつつ、現時点の provider 差分を無理に潰さずに済むため
- 影響範囲: `docs/design/provider-adapter.md`, `docs/design/agent-event-ui.md`, `src/App.tsx`, `src-electron/main.ts`
