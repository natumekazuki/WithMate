# Plan

## Goal

- `GitHub Copilot CLI` を WithMate の current Session UI から 1 turn 実行できるようにする
- 既存の Codex 実装を壊さず、provider 境界で `CopilotAdapter` を追加する
- `基本 turn 実行` の slice として、最小限の prompt / response / session 保存までを通す

## Scope

- `@github/copilot-sdk` の導入
- `CopilotAdapter` の最小実装
- Main Process の provider dispatch 追加
- model catalog への `copilot` provider 追加
- session 作成から 1 turn 実行までの最小フロー実装

## Out Of Scope

- Copilot streaming 専用 UI polish
- approval mode の厳密 mapping
- session resume
- cancel / interrupted の完全対応
- file / folder / image attachment
- skill / agent / slash command
- artifact / diff の Copilot parity

## Task List

- [x] Plan を作成する
- [x] Copilot SDK の local surface を確認する
- [x] `copilot` provider を model catalog / settings / session selection に追加する
- [x] `CopilotAdapter` を追加して最小 turn 実行を実装する
- [x] Main Process の provider dispatch を追加する
- [x] 最小検証を実施する
- [x] docs と capability matrix を同期する

## Affected Files

- `package.json`
- `package-lock.json`
- `public/model-catalog.json`
- `src-electron/copilot-adapter.ts`
- `src-electron/main.ts`
- `src/model-catalog.ts`
- `docs/design/provider-adapter.md`
- `docs/design/coding-agent-capability-matrix.md`

## Risks

- Copilot SDK は technical preview で surface が変わりやすい
- permission handler が必須なので、approval mode 未実装の暫定方針が必要
- current audit / artifact schema は Codex 前提が強く、最初は最小保存に留める必要がある

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/provider-adapter.md`, `docs/design/coding-agent-capability-matrix.md`
- メモ: runtime が `CodexAdapter` only ではなくなるので current snapshot を更新する
