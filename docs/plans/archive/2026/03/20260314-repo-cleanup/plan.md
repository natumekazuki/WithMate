# Plan

## Goal

- 現在の実装一式を復元可能なスナップショットとして先にコミットする
- その後、モック／スパイク／初期検証の残滓を削除して、Electron 実装を正本とするクリーンな状態へ整理する

## Scope

- 現在差分の棚卸し
- 現状スナップショットコミット
- browser fallback / localStorage mock / モック命名の整理
- 旧モック資産、スパイク資産、完了済み旧 Plan の整理
- 関連 design / README / .ai_context の同期
- クリーンアップ後コミット

## Task List

- [ ] 残す本番資産と削除対象を確定する
- [ ] 現状スナップショット用の Plan 記録を整える
- [ ] 現在の状態を 1 コミットに固定する
- [ ] モック／スパイク残滓を削除し、実装と命名を本番向けに整理する
- [ ] docs/design、README、必要なら .ai_context を同期する
- [ ] 検証後にクリーンアップ済み状態を 1 コミットに固定する

## Affected Files

- `src/`
- `src-electron/`
- `scripts/`
- `docs/design/`
- `docs/plans/`
- `README.md`
- `package.json`
- `vite.config.ts`
- `mock/`

## Risks

- browser fallback を外すと、Electron 以外での単体確認導線が消える
- `mock-data.ts` 系の命名整理は参照箇所が広く、型や import の取りこぼしが起きやすい
- 旧 Plan / 旧 docs の整理で、参照リンク切れを発生させる可能性がある
- スパイク資産を落としすぎると、実装判断の根拠が docs から消える可能性がある

## Design Doc Check

- 状態: 確認済み
- 対象候補: `docs/design/provider-adapter.md`, `docs/design/window-architecture.md`, `docs/design/electron-window-runtime.md`, `docs/design/model-catalog.md`, `docs/design/session-persistence.md`, `README.md`, `.ai_context/`
- メモ: cleanup 後の構成に合わせて、モック前提・スパイク前提の記述を削る

