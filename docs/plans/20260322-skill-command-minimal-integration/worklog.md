# Worklog

## Timeline

### 0001

- 日時: 2026-03-22
- チェックポイント: Plan 作成
- 実施内容: `/skill` 最小実装の plan を作成した
- 検証: 未実施
- メモ: 次は skill root と workspace skill の merge ルールを固める
- 関連コミット: `9e10ab6` `docs(plan): add minimal skill command plan`

### 0002

- 日時: 2026-03-22
- チェックポイント: Skill picker 最小実装
- 実施内容:
  - provider ごとの `skillRootPath` を `AppSettings` に追加した
  - Main Process に skill discovery と `listSessionSkills` IPC を追加した
  - Session composer で `Skill` dropdown と選択時の provider 別 snippet 挿入を実装した
  - Home Settings に `Skill Root` 入力と `Browse` を追加した
  - design docs と manual test checklist を同期した
- 検証:
  - `npm run typecheck`
  - `node --import tsx --test scripts/tests/approval-mode.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/skill-discovery.test.ts`
  - `npm run build`
- メモ:
  - workspace 側の探索は標準 skill roots 限定
  - 同名 skill は workspace 優先で dedupe
  - Skill picker から選んだ skill は provider に応じた snippet へ変換して composer 先頭へ挿入する
- 関連コミット:

### 0003

- 日時: 2026-03-22
- チェックポイント: Skill picker UX fix
- 実施内容:
  - textarea 内の `/skill` parse と入力ブロックを削除した
  - Session composer 上部の `Skill` dropdown からのみ skill を選べるようにした
  - skill 0 件時の empty state を dropdown 内に追加した
  - design docs と manual test checklist を dropdown 前提へ更新した
- 検証:
  - `npm run typecheck`
  - `node --import tsx --test scripts/tests/approval-mode.test.ts scripts/tests/app-settings-storage.test.ts scripts/tests/skill-discovery.test.ts`
  - `npm run build`
- メモ:
  - textarea に `/skill` を入力しても special handling はしない
  - Skill picker の主導線は toolbar button に固定した
- 関連コミット:

## Open Items

- manual test は未実施
