# Plan

## Goal

- `#30 送信後フッター自動 close` として、Session Window の `Action Dock` を送信後に自動で compact へ戻せるようにする
- その挙動を Settings の checkbox で切り替えられるようにする

## Scope

- `AppSettings` に auto close 設定を追加する
- Settings Window の checkbox 追加
- Session Window の送信後 auto collapse 挙動追加
- tests / docs / backlog / plan artefact 更新

## Out Of Scope

- retry banner や blocked state の force-expanded policy 見直し
- `#16` `#25` の memory trigger policy
- Session layout 全体の再設計

## Task List

- [x] repo plan を作成する
- [x] current `Action Dock` state と settings 保存経路を確認する
- [x] 設定項目と default を決める
- [x] 実装とテストを更新する
- [x] docs を同期する
- [x] 必要な検証を実行する

## Affected Files

- `src/provider-settings-state.ts`
- `src/home-settings-draft.ts`
- `src/home-components.tsx`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/settings-ui.ts`
- `src-electron/app-settings-storage.ts`
- `scripts/tests/provider-settings-state.test.ts`
- `scripts/tests/home-settings-draft.test.ts`
- `scripts/tests/home-settings-view-model.test.ts`
- `scripts/tests/app-settings-storage.test.ts`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `docs/task-backlog.md`

## Risks

- force-expanded 条件と auto collapse が競合すると、送信後の dock state が分かりづらくなる
- Settings 既定値と storage default がずれると既存 DB で挙動が不安定になる

## Validation

- `node --import tsx scripts/tests/provider-settings-state.test.ts`: 成功
- `node --import tsx scripts/tests/home-settings-draft.test.ts`: 成功
- `node --import tsx scripts/tests/home-settings-view-model.test.ts`: 成功
- `node --import tsx scripts/tests/app-settings-storage.test.ts`: 成功
- `npm run build`: 成功

## Docs Sync

- `docs/design/desktop-ui.md`: 更新した。理由: `Action Dock` の default / Settings 連動を current 仕様へ同期するため
- `docs/manual-test-checklist.md`: 更新した。理由: 送信後 auto close の実機観点を追加するため
- `docs/task-backlog.md`: 更新した。理由: `#30` の状態を current 実装へ同期するため
- `.ai_context/`: 更新不要。理由: UI 設定と renderer 挙動の slice に留まり、workspace rule や coding rule は変わらないため
- `README.md`: 更新不要。理由: アプリ入口や概要説明は変わらないため
