# Decisions

## 2026-03-29

### issue 3 fallback 条件に該当する

- 参照:
  - `docs/plans/archive/2026/03/20260329-review-findings-remediation/decisions.md`
- archive 側 issue 3 decision では、`sandbox: true` を first attempt としつつ、preload API / IPC 利用に影響が出る場合は `sandbox: false` へフォールバックする方針だった
- 今回は `npm run electron:start` の Home Window で `window.withmate` 注入が成立せず、renderer が `Home は Electron から起動してね。` fallback へ落ちるため、そのフォールバック条件を満たしている
- このため current task では renderer 文言ではなく preload 注入成立を優先し、`src-electron/main.ts` の `sandbox` を `false` へ戻す

### same-plan ではなく new-plan にする

- remediation plan 自体は archive 済みで、完了済みの成果物として閉じている
- 今回の作業は review findings の同一実装ではなく、archive 後に判明した runtime regression の是正である
- そのため current task は same-plan ではなく、新規 follow-up plan として追跡する
