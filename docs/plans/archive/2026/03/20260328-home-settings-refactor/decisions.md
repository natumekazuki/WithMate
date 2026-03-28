# Decisions

## D-001 Settings async handler は action helper へ寄せる

- import / export / save / reset の文言組み立てと戻り値解釈は helper に分離する
- `HomeApp.tsx` では state 反映と window API 呼び出しの接着だけを行う

## D-002 Settings loading/reset の派生状態は projection helper で持つ

- `settingsWindowReady`
- selected reset targets の説明
- reset target ごとの checked / disabled
- reset 実行可否
を helper で組み立てる
