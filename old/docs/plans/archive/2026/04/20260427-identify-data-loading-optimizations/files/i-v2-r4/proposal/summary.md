# Proposal Summary

- `i-v2-r4` は red フェーズの範囲。
- 実施済み: `scripts/tests/persistent-store-lifecycle-service.test.ts` に V2 起動時のレグレッションテストを追加。
- 証跡: 追加テストは現状コードで失敗を再現し、`V1 write-capable storage をそのまま使うと起動で壊れる` ことを示した。
- 次アクション: 本体実装側で V2 判定 + V2 read storage への切替えを実装し green 化。
