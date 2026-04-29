# Memory Architecture

- 作成日: 2026-03-12
- 更新日: 2026-04-27
- 対象: Project Memory / Session Memory / Character Memory の責務設計
- 関連 Issue:
  - `#3 LangGraphを使ってMemoryの永続化と共有`
  - `#1 定期実行はサブスクリプションだと規約違反の可能性がある`
  - `#14 memoryに時間経過の評価値追加`
  - `#15 キャラストリームをメモリー生成の一部にする`

## Goal

WithMate における Memory を、保存データとしての責務と coding plane prompt への利用可否に分けて定義する。

2026-04-27 時点では、MemoryGeneration と独り言 / character reflection runtime は削除する。理由は保存容量や描画軽量化ではなく、AI agent に渡す prompt の token 効率と有用性を改善するためである。

## Position

- Memory 全体方針の正本はこの文書とする
- coding plane への prompt 注入 detail は `docs/design/prompt-composition.md` を参照する
- 独り言削除後の方針は `docs/design/monologue-provider-policy.md` を参照する
- `Project Memory` の storage detail は `docs/design/project-memory-storage.md` を参照する
- `Character Memory` の storage detail は `docs/design/character-memory-storage.md` を参照する

## Current Runtime Policy

current runtime では次を行わない。

- turn 完了後の `Session Memory` 自動抽出
- `Session Memory` から `Project Memory` への自動昇格
- coding plane prompt への `Session Memory` 常設注入
- coding plane prompt への `Project Memory` retrieval 注入
- `Character Memory` 更新のための background reflection
- 独り言生成
- `Session Window` 右ペインでの MemoryGeneration / 独り言 tab 表示
- Settings での `Memory Generation` / `Memory Extraction` / `Character Reflection` 設定表示

既存 DB data は削除しない。保存済み `session_memories`、`project_memory_entries`、`character_memory_entries`、`sessions.stream_json`、background `audit_logs` は互換用の既存データとして残す。

## Design Summary

WithMate の Memory は保存データとしては 3 層に分ける。

1. `Project Memory`
- 作業対象単位で共有したい永続記憶
- session をまたいでも持ち越したい durable knowledge
- current runtime では coding plane prompt に再注入しない

2. `Session Memory`
- その session を継続するための working memory
- compact 後や再開後でも、作業の目的や決定事項が欠落しないための記憶
- current runtime では自動生成も prompt 常設注入も行わない

3. `Character Memory`
- ユーザーと character の関係性や積み重ね
- project や task と分離して character 単位で持つ記憶
- current runtime では background reflection で更新しない
- coding plane prompt には注入しない

## Why Disabled

過去 prompt の監査では、短い依頼ほど `Session Memory` と `Project Memory` が入力の大半を占めていた。実際の効果としても、現在の MemoryGeneration は有益な prompt 文脈を安定して作れていない。

このため current task では、Memory を改善しながら延命するのではなく、いったん runtime から外す。再実装する場合は、次を明示した別設計にする。

- 何を保存するか
- いつ生成するか
- prompt に戻す条件
- token 予算
- 効果測定
- 失敗時の縮退

## Storage Compatibility

Memory 関連 table は直ちに削除しない。

- 既存ユーザーデータを破壊しない
- schema migration のリスクを current task に混ぜない
- 将来、閲覧 / 手動管理 / 再設計で再利用できる余地を残す

ただし current runtime はこれらを新規 prompt 文脈として扱わない。

## Data Domains

### Project Memory

保持対象の例:

- project 全体の方針
- 設計上の前提
- 継続的に使うディレクトリ構成の意味
- 次回の session でも有効な判断

current runtime:

- 既存 entry は保存されたまま残る
- coding plane prompt への retrieval 注入は行わない
- turn 完了後の自動昇格は行わない
- 管理 UI や DB reset での既存データ扱いは互換範囲として残してよい

### Session Memory

保持対象の例:

- session の目的
- 現在の task summary
- 直近で決めたこと
- unresolved な論点
- 次にやること

current runtime:

- 既存 row は保存されたまま残る
- session 作成時の互換 row 作成は残っていてもよい
- turn 完了後の自動抽出は行わない
- manual extraction は no-op とする
- coding plane prompt への常設注入は行わない

### Character Memory

保持対象の例:

- ユーザーとの呼び方
- 距離感
- 継続した反応傾向
- 一緒に過ごした時間として残したい印象

current runtime:

- 既存 entry は保存されたまま残る
- `character reflection cycle` は実行しない
- 独り言生成は行わない
- coding plane prompt には注入しない

## Session Memory v1 Schema

既存互換として `Session Memory v1` schema は維持する。

```ts
type SessionMemoryV1 = {
  schemaVersion: 1;
  goal: string;
  decisions: string[];
  openQuestions: string[];
  nextActions: string[];
  notes: string[];
  updatedAt: string;
};
```

この schema は保存済みデータの読み書き互換のために残る。current runtime では自動抽出結果として更新しない。

## Prompt Injection Policy

Memory は current coding plane prompt へ入れない。

- `Session Memory`
  - 常設注入しない
- `Project Memory`
  - retrieval hit があっても注入しない
- `Character Memory`
  - coding plane prompt に入れない

current の coding plane prompt は次の順序を基本にする。

1. app / provider の system 指示
2. `character.md`
3. ユーザー入力

具体的な section 書式は `docs/design/prompt-composition.md` を正本にする。

## Background Processing Policy

current runtime では memory extraction plane を起動しない。

- 通常 turn と同じ provider session に混ぜない
- 別 request としても実行しない
- background audit log を新規作成しない
- MemoryGeneration の Settings UI は表示しない

旧設計で定義していた `outputTokens threshold`、manual extraction、`character reflection cycle`、context growth trigger は legacy policy として扱い、current runtime の発火条件にはしない。

## Audit Logging Policy

既存の background memory extraction / character reflection log は `audit_logs` に残る場合がある。

current runtime では新規 background memory extraction / character reflection log を作らない。Audit Log UI が既存 background log を表示できることは互換要件として残してよい。

## UI Policy

current UI では次を表示しない。

- Settings の `Memory Generation`
- Settings の `Memory Extraction`
- Settings の `Character Reflection`
- Session Window 右ペインの `Memory Generation`
- Session Window 右ペインの `独り言`

Memory Management Window の既存データ閲覧 / delete 機能は、別途残すか削るかを個別判断する。current runtime の prompt 効率には影響しないため、今回の削除範囲では既存 DB data の破壊はしない。

## Reimplementation Policy

MemoryGeneration を再実装する場合は、旧 v1 の復帰ではなく新規設計として扱う。

最低限、次を事前に決める。

- Memory を prompt に戻す条件
- 1 turn あたりの token 予算
- user input との relevance threshold
- 生成結果の評価方法
- 誤った decision / note を増やさない validation
- 手動編集や確認 UI の有無
- background call の provider / model / timeout

## Non Goals

- 既存 Memory data の削除
- Memory 関連 table の schema migration
- 独り言の代替 UI 実装
- 旧 MemoryGeneration v1 の改善

## Related

- `docs/design/prompt-composition.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/project-memory-storage.md`
- `docs/design/character-memory-storage.md`
- `docs/design/database-schema.md`
