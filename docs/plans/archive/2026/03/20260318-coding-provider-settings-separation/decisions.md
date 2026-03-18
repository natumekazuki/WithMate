# Decisions

## Summary

- current Settings は **coding plane 用設定**として扱い、`Character Stream` 用設定とは切り離す
- canonical shape は `codingProviderSettings` とし、legacy fallback を前提にしない
- 初回リリース前のため後方互換性は考慮しない
- 非互換変更時は Settings の `DB を初期化` を回復導線の正本とする
- `DB を初期化` は `sessions / audit logs / app settings / model catalog` を初期化し、`characters` は保持する

## Decision Log

### 0001

- 日時: 2026-03-18
- 論点: Settings の provider / credential をどの plane の設定として扱うか
- 判断: current Settings は `coding plane` 専用と明示し、`Character Stream` / monologue plane とは分離する
- 理由:
  - 既調査の結論として、既存 provider 設定と API key は coding runtime 用である
  - current milestone では `Character Stream` は未着手維持が確定している
  - UI だけでなく設計説明でも plane 境界を明示しないと再度混乱しやすい

### 0002

- 日時: 2026-03-18
- 論点: state / storage の canonical shape をどう固定するか
- 判断: `codingProviderSettings` を canonical shape とし、legacy `providerSettings` / `provider_settings_json` 維持は採用しない
- 理由:
  - 初回リリース前のため互換維持コストより current 実装の一貫性を優先できる
  - tests / docs / runtime contract を canonical-only へ揃えた方が今後の判断が明確になる
  - legacy fallback を plan docs に残すと current policy と矛盾する

### 0003

- 日時: 2026-03-18
- 論点: 非互換変更時の回復導線をどう扱うか
- 判断: Settings overlay の `Danger Zone` に `DB を初期化` を置き、ここを回復手段の正本とする
- 理由:
  - settings / catalog / sessions をまとめて再初期化できる
  - current milestone では migration より reset recovery の方が説明しやすい
  - `characters` を消さないことで再セットアップ負担を最小化できる

### 0004

- 日時: 2026-03-18
- 論点: Character Stream の扱いを今回どこまで進めるか
- 判断: docs 上の境界整理だけ行い、UI / backend / settings 実装は追加しない
- 理由:
  - current milestone の非対象を破らないため
  - coding plane 側の parity と recovery policy の同期を優先するため

### 0005

- 日時: 2026-03-18
- 論点: 以前の「legacy fallback を維持する」判断をどう扱うか
- 判断: superseded。current policy は canonical-only + DB reset recovery とする
- 理由:
  - 初回リリース前は後方互換性を考慮しない方針へ揃えたため
  - repo docs / tests / UI を同じ前提へ統一する必要があるため
