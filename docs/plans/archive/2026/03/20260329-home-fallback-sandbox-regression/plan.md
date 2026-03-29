# Plan

## Goal

- `npm run electron:start` 時に Home Window が browser fallback へ落ちず、`window.withmate` を受け取れる状態へ戻す
- archive 済み review findings remediation の issue 3 decision に従い、fallback 条件へ入った場合は `sandbox: false` を優先する
- 実装理由と current runtime の前提を docs に残す

## Scope

- `src-electron/main.ts` の BrowserWindow `sandbox` 設定見直し
- `docs/design/electron-window-runtime.md` の current 実装反映
- `docs/plans/20260329-home-fallback-sandbox-regression/` 配下の記録更新
- session plan の current task 更新

## Out Of Scope

- `src/HomeApp.tsx` の fallback 文言や renderer 側分岐の再設計
- `src-electron/main.ts` の構造改善や大規模分割
- 他 issue の typecheck baseline 解消

## Why New-Plan

- archived plan `docs/plans/archive/2026/03/20260329-review-findings-remediation/` は remediation 完了として閉じている
- 今回は完了済み decision の fallback 条件が `npm run electron:start` で実際に発生したため、その事後回帰を独立 task として記録する必要がある
- same-plan へ混在させると、archive 後の回帰修正と完了済み remediation 本体の境界が曖昧になる

## Validation

- `npm run build`
- `npm test`
- `npm exec tsc -p tsconfig.electron.json --noEmit --pretty false`
- shell ベースの `npm run electron:start` smoke を実施し、CLI 制約下では即時クラッシュや明確な preload failure がないことを確認対象にする
