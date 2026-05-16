# Memory Architecture

- 作成日: 2026-03-12
- 更新日: 2026-05-03
- 対象: Project Memory / Session Memory / Character Memory の責務設計
- 関連 Issue:
  - `#3 LangGraphを使ってMemoryの永続化と共有`
  - `#1 定期実行はサブスクリプションだと規約違反の可能性がある`
  - `#14 memoryに時間経過の評価値追加`
  - `#15 キャラストリームをメモリー生成の一部にする`

## Goal

WithMate における Memory を、保存データとしての責務と coding plane prompt への利用可否に分けて定義する。

2026-04-27 時点では、MemoryGeneration と独り言 / character reflection runtime は削除する。理由は保存容量や描画軽量化ではなく、AI agent に渡す prompt の token 効率と有用性を改善するためである。

2026-05-03 の 4.0.0 方針では、WithMate は完全 SingleMate へ移行する。旧 Memory runtime を復活させず、Mate の継続性は `Growth Candidate`、`Bond Profile`、`Work Style`、tag 付き Profile Item として再設計する。Growth Candidate は 4.0.0 から実装し、毎回のユーザー承認ではなく、Mate の自律的な profile 更新として扱う。

4.0.0 の Memory / Growth は project 単位で分割された保存領域ではない。
機械学習 dataset の tag に近い形で、Memory ID に紐づく別 table に `tag_type` と `tag_value` を持たせ、制限なしで複数 tag を付与して扱う。
Profile Item tag は source Memory tags から継承または render 時に派生させる。
tag は enum ではなく open string とするが、類似 tag の増殖を防ぐため `mate_memory_tag_catalog` を持つ。
Memory Candidate 生成時は tag catalog snapshot を毎回渡し、既存 tag の再利用を優先させる。
適した既存 tag がない場合だけ、LLM は `newTags` と理由を返し、app 側の正規化 / 類似判定を通して catalog に追加する。
Relevant Memory Retrieval は 4.0.0 MVP から hybrid retrieval とし、SQL / tag / claimKey / recency / salience で候補を絞り、embedding similarity で意味近傍を拾い、rule score で rerank する。
embedding は Codex / Copilot などの AI agent provider ではなく、初回 download 後に local cache から CPU 実行する app internal backend で生成する。
4.0.0 MVP の既定 model は `Xenova/multilingual-e5-small`、dimension は 384 とする。
初回 model download は Settings の明示 download button から開始し、download 完了まで semantic retrieval、embedding generation、embedding similarity rerank は実行しない。
Memory Candidate 生成そのものは SQL / tag / claimKey retrieval に縮退して実行してよい。
Memory Candidate / Profile Update / Project Digest 用の LLM execution は purpose ごとの fixed priority list を使い、provider / model / depth を設定できる。
Project Digest は project tag 付き Profile Item から必要時に render される projection の一種である。
Git 管理下 workspace は Git 情報から project tag を作り、Git 非管理 workspace には project tag を付与しない。

## Position

- Memory 全体方針の正本はこの文書とする
- SingleMate の Growth 詳細は `docs/design/single-mate-architecture.md` を参照する
- Growth Engine の service / policy / forget 詳細は `docs/design/mate-growth-engine.md` を参照する
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

## 4.0.0 Growth Policy

4.0.0 では、Memory という名前で旧 runtime を戻さず、Mate Profile の成長として扱う。

### Core Idea

Mate が育つとは、過去ログを大量に保存して prompt に戻すことではない。
ユーザーとの関係性、作業好み、一緒に決めた方針が、短く安定した Mate Profile に反映されることである。

### Data Flow

1. session / turn から Growth Candidate を生成する
2. Memory 生成 LLM が保存すべき内容だけ `memories[]` に返し、StorageGate で schema validation だけを行う
3. Growth Event と evidence を保存する
4. Profile Update Skill が structured Profile Operation を返す
5. PostPolicyGate で operation と projection 境界を検査する
6. Profile Item を更新する
7. active Profile Item から canonical Markdown projection を完全再生成する
8. Mate Profile revision を保存する
9. UI で反映済み Growth / Profile Item を表示する
10. ユーザーは後から修正 / 忘却 / 無効化できる
11. 次回 provider instruction sync で projection に反映する

### Growth Engine

Growth Candidate の実装正本は `docs/design/mate-growth-engine.md` とする。

4.0.0 MVP では MCP を必須にしない。WithMate が保持する session / companion / audit / message metadata と Mate Profile を入力にし、Growth ledger、Mate Profile revision、Markdown section の更新を出力にする。

Growth Engine は provider instruction file を直接書かない。Growth apply 後に provider instruction target を stale にし、書き込みは provider instruction sync に委譲する。

Profile 反映は、前回 Growth apply から 1 時間以上経過し、pending Memory がある場合を主 trigger にする。
人の記憶に近い挙動として、反復、重要度、最近性、時間経過による弱化、矛盾訂正を Growth score として扱う。

Growth Event から Markdown へ直接書かない。Profile Update Skill は Markdown 全文ではなく structured Profile Operation を返し、PostPolicyGate を通した後に Profile Item を更新する。
Markdown は active Profile Item と manual notes から render する。

Memory Candidate 生成は通常 turn response に含めない。
WithMate が app internal background execution として provider / LLM を呼び、UI に出さずに返却 JSON を Zod などで検証する。
schema validation を通った candidate は全件 Growth Event / Memory として DB に保存する。
保存可否の意味判断は Memory 生成 LLM の責務であり、アプリ側は保存前 gate として意味判定をしない。
background run は user-facing provider thread を再利用せず、WithMate DB から取得した relevant Memory、Profile Item、forgotten tombstone、tag catalog を明示 input として渡す。
これにより、provider session 履歴に hidden turn を残さずに、反復、更新、矛盾、上書き候補を扱う。
relevant Memory / Profile Item の取得は SQL filter と local embedding retrieval の hybrid とする。
embedding が未生成、model cache missing、index recovery 中の場合は SQL / tag / claimKey retrieval に fallback するが、MVP の正規ルートは hybrid とする。
fallback は失敗時の縮退であり、Codex / Copilot などの AI agent provider を embedding 生成に使わない。
4.0.0 MVP では local embedding model の priority list や環境依存 auto selection は持たない。
cache は temporary download、manifest 検証、active cache 昇格の順で管理し、破損や revision mismatch を検出した場合は embedding retrieval を止める。

MCP は 4.0.0 MVP の必須要件にしない。ただし、SQL Memory / Growth Event から関連する記憶を取り出す read-only MCP は将来追加できる。
MCP は profile を更新する主体ではなく、関連 Memory を検索する窓口として扱う。

### Prompt Policy

- Growth Event 履歴は coding plane prompt に常設しない
- Growth Candidate は entry のまま prompt / provider instruction に入れない
- Growth Event は Mate Profile へ圧縮反映する
- provider instruction projection には短い現在状態だけを入れる
- Growth の保存可否と provider instruction projection 可否は別判定にする
- `projection_allowed = false` の Growth は provider instruction file に出さない

### Safety

- 毎回のユーザー承認は要求しない
- 自律反映する情報は、明示的な好み、継続的な作業傾向、共有した方針に絞る
- 推測だけで関係性を固定しない
- `core.md` への自律反映は 4.0.0 MVP では行わない
- 誤った Growth は profile / revision / evidence / provider projection から忘れられるようにする
- 忘却済み fingerprint は再抽出で復活させない
- Growth 抽出 provider と coding provider を同一にするかは別途設計する

## Non Goals

- 既存 Memory data の削除
- Memory 関連 table の schema migration
- 独り言の代替 UI 実装
- 旧 MemoryGeneration v1 の改善
- Growth Event 全履歴の prompt 注入

## Related

- `docs/design/single-mate-architecture.md`
- `docs/design/mate-growth-engine.md`
- `docs/design/prompt-composition.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/project-memory-storage.md`
- `docs/design/character-memory-storage.md`
- `docs/design/database-schema.md`
