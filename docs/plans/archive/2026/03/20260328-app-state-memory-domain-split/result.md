# Result

- 状態: completed

## メモ

- `app-state.ts` の Memory / background activity 領域を domain split した

## 完了内容

- `src/memory-state.ts` を追加し、Memory domain と background activity の shared type / helper を分離した
- `app-state.ts` から該当定義を外し、re-export に切り替えた
- Memory 系の source / test import を新しい module に寄せた

## 次

- 次は `app-state.ts` に残っている `Settings provider config` と `Session / Character` 周辺の split を検討する
