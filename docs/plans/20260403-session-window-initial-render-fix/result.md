# Result

- status: completed

## Summary

- `#39` の Session Window 初期表示エラーは `src/App.tsx` の TDZ 例外が原因だった
- `auditLogRefreshSignature` が初回 render 中に後方定義の `displayedMessages` を参照していたため、`selectedSession?.messages.length ?? 0` へ置き換えて解消した
- desktop runtime で `App` を server render しても落ちない回帰 test を追加した

## Commits

- なし
