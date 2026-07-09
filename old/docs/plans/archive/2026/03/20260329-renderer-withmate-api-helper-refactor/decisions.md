# 20260329 Renderer WithMate API Helper Refactor Decisions

## 初期判断

- first slice は共通 helper の追加と主要 renderer での利用に絞る
- `require` ではなく `null` を返す取得 helper と desktop runtime 判定 helper を用意する
- UI 挙動は変えず、guard の重複を減らすことを優先する
