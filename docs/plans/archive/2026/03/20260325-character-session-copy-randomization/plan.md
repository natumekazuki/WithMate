# 20260325 character-session-copy-randomization

## Goal

- Character Editor の `Session Copy` でスクロールできるようにする
- 各 copy slot に複数候補を持たせ、SessionWindow ではそこから安定ランダムで 1 件を選ぶ

## Scope

- `CharacterSessionCopy` の型を `string` から `string[]` へ変更
- Character Editor の `Session Copy` 入力を複数行編集へ変更
- SessionWindow の copy lookup を複数候補対応に変更
- session-copy tab のスクロール修正

## Out Of Scope

- provider prompt への反映
- Home / monitor / settings copy
- weighted random や条件分岐 copy

## Steps

1. `CharacterSessionCopy` の保存形式を複数候補対応にする
2. Character Editor で 1 行 1 候補として編集できるようにする
3. SessionWindow では stable seed を使って候補から 1 件選ぶ
4. docs と manual test を同期する
