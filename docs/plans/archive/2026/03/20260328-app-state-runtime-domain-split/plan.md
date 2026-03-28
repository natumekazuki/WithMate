# Plan

- 目的: `app-state.ts` に残っている `Audit / LiveRun / Telemetry / Composer` shared state を domain module へ分離し、renderer/main 間の import 境界を明確にする
- 完了条件:
  - `src/app-state.ts` が runtime shared state の re-export hub に整理される
  - `Audit / LiveRun / Telemetry / Composer` の型と helper が新 module へ移る
  - 関連 import が更新され、`npm run build` と関連 unit test が通る
- スコープ外:
  - SQLite storage や service のロジック変更
  - UI 表示や event 契約の仕様変更
