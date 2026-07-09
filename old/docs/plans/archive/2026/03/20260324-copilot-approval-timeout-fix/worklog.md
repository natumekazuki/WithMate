# Worklog

## 2026-03-24

- `docs/FailedLog.json` を確認し、approval 後に `powershell` が長時間実行され、`read_powershell` / `stop_powershell` まで進んでいる一方で `session.idle` へ戻る前に timeout していることを確認した
- `src-electron/copilot-adapter.ts` を確認し、turn 完了待機が `session.sendAndWait(..., 180_000)` 固定になっていることを確認した
- `src-electron/copilot-adapter.ts` の待機を `sendAndWait(..., 180_000)` から event stream ベースの `session.idle` / `session.error` / cancel 待機へ置き換えた
- `npm run build` を実行し、renderer / electron build が通ることを確認した
- docs 更新要否を確認し、今回は provider contract や UI 変更がないため design doc / manual test checklist の更新は不要と判断した

## Next

- Copilot 実機で approval 後に 3 分超の command を流し、timeout が再発しないことを確認する
