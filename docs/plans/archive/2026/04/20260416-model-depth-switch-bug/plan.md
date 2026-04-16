# 20260416 model-depth-switch-bug

## 目的

- Session などの model 切り替え時に、現在選択中の reasoning depth が切り替え先 model に存在しない場合でも切り替え失敗にせず、利用可能な depth へ安全に fallback させる。

## 調査観点

- `src/App.tsx` の session model / reasoning depth 更新フロー
- `src/model-catalog.ts` の model 選択解決と fallback 規約
- 既存 test で同系統の回帰を拾えているか

## 実施方針

1. model 切り替え時に選択解決がどう失敗するかをコード上で特定する。
2. 切り替え先 model に非対応の reasoning depth を渡しても、利用可能な値へ補正して session 更新できるよう修正する。
3. 回帰 test を追加し、必要なら design / context の更新要否も確認する。

## 完了条件

- model 切り替え時に unsupported な reasoning depth が残っていても session 更新が成功する。
- reasoning depth 明示変更時の既存挙動は壊さない。
- 関連 test と build が通る。
