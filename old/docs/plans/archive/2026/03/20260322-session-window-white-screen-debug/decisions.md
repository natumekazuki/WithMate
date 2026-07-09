# Decisions

## Summary

- 白画面の主因は DB ではなく、`selectedSession` が未解決な初期描画で `runState` を参照していた renderer 例外だった
- `src/App.tsx` の null ガード前にある `selectedSession.runState` を optional chain ベースの判定へ置き換えて復旧する
- DB schema や永続データには今回触れていないため、DB 初期化は不要と判断する
- design docs は更新しない。理由は wide layout の見た目仕様ではなく初期描画の防御不足修正だから
