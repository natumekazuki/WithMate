# Monologue Provider Policy

- 作成日: 2026-03-12
- 更新日: 2026-04-27
- 対象: 独り言機能と `character reflection cycle` の実行方式
- 関連 Issue:
  - `#1 定期実行はサブスクリプションだと規約違反の可能性がある`
  - `#3 LangGraphを使ってMemoryの永続化と共有`
  - `#5 独り言システムはペンディング`
  - `#15 キャラストリームをメモリー生成の一部にする`

## Goal

独り言機能と `character reflection cycle` の current policy を定義する。

2026-04-27 時点では、独り言機能は runtime から削除する。語彙や表現の変化が乏しく、AI agent の token 効率改善を優先する current task では維持価値が低いと判断したためである。

## Position

- この文書は独り言 / character reflection backend と trigger policy の正本とする
- Character Memory の保存構造は `docs/design/character-memory-storage.md` を参照する
- coding plane の provider 境界は `docs/design/provider-adapter.md` を参照する

## Decision Summary

1. 独り言生成は current runtime では実行しない
2. `character reflection cycle` は current runtime では実行しない
3. `SessionStart` での monologue only 生成は行わない
4. 文脈増加ベースの background reflection は行わない
5. `Session Window` 右ペインに `独り言` tab は表示しない
6. 既存の `sessions.stream_json` に残る monologue entry は削除しない
7. 既存の `character_memory_entries` は削除しない
8. 将来再実装する場合は、今回削除した v1 の延長ではなく、効果測定と prompt 設計を含む新設計として扱う

## Runtime Policy

current runtime では独り言 plane を持たない。

- coding turn 完了後に独り言を生成しない
- session window open 時に独り言を生成しない
- background task として `CharacterMemoryDelta` を生成しない
- `Character Reflection model / reasoning depth / timeout` 設定は UI に表示しない
- `Memory Generation` global toggle で独り言を制御する経路は使わない

## Storage Compatibility

過去バージョンで保存されたデータは互換用に残す。

- `sessions.stream_json`
  - 既存の monologue entry が残る場合がある
  - current runtime では新規 monologue entry を追記しない
- `character_memory_entries`
  - 既存の Character Memory entry が残る場合がある
  - current runtime では background reflection から新規 entry を保存しない
- `audit_logs`
  - 既存の background reflection log が残る場合がある
  - current runtime では新規 background reflection log を作らない

## Prompt Boundary

独り言削除後も、coding plane の prompt boundary は独立して扱う。

- `character.md` は coding plane の character role として使う
- `Character Memory` は coding plane prompt に注入しない
- `Session Memory` / `Project Memory` も current runtime では coding plane prompt に注入しない

## UI Policy

current UI では `独り言` の表示面を持たない。

- `Session Window` 右ペインの tab order から `monologue` を外す
- background activity と recent monologue の表示を新規導線として出さない
- 既存データ閲覧のための互換 UI は current task の対象外

## Future Reimplementation Policy

独り言を再実装する場合は、次を事前に設計する。

- どの入力文脈が表現の変化に寄与するか
- token 予算
- 生成頻度
- UI 上の価値
- Character Memory との関係
- coding plane prompt への影響を持たない provider boundary

旧 v1 の `character reflection cycle` をそのまま復帰することは current recommendation ではない。

## Non Goals

- 既存 monologue data の migration / deletion
- 独立 monologue plane の current milestone 実装
- Character Memory の schema 削除

## Related

- `docs/design/memory-architecture.md`
- `docs/design/database-schema.md`
- `docs/design/prompt-composition.md`
