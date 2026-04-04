# Result

- status: in_progress

## Summary

- docs / code に残る pre-release 前提の文言を抽出した
- 正式リリース前に削除優先度が高いものは、互換性 note、future scope note、manual update follow-up note の 3 系統に集中している
- issue / backlog 自体は管理用途なので削除対象ではなく、公開面と user-visible copy を先に整理するのが妥当
- item 1 の互換性 note 削除は着手済みで、README / Settings / manual checklist / design docs へ反映した
- item 2 の future scope note 削除も着手済みで、Settings credential 補助文、README、checklist の未着手案内を整理した
- item 3 の follow-up task 参照削除も着手済みで、Memory 管理 UI の補助文を feature 現況だけへ寄せた
- Settings では説明文だけを整理し、設定項目そのものは維持した
- 例外として `Coding Agent Credentials` と `Danger Zone` は section ごと削除し、`Memory 管理` は Home 右ペイン専用導線へ寄せた
- `npm run build` は成功しており、renderer / electron とも current UI に揃っている
- version は `1.0.0` に戻し、Memory 管理 UI の補助文も削除した

## Commits

- `7b32fec` `fix(settings): 正式リリース向けに設定UIを整理する`
- `ccae920` `fix(release): v1.0.0 へ整える`
