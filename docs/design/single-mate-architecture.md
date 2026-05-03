# SingleMate Architecture

- 作成日: 2026-05-03
- 対象: WithMate 4.0.0 の SingleMate 化と Mate Profile の責務設計

## Goal

WithMate 4.0.0 を、複数 character を選んで使う app ではなく、1 つの環境に 1 人の Mate が定着して育つ coding companion として定義する。

この文書は、SingleMate 化に伴う product boundary、storage、UI、session 連携、Growth の責務を固定する。

## Position

- 4.0.0 以降の Mate / character 体験の正本はこの文書と `docs/design/product-direction.md` とする
- provider instruction への同期詳細は `docs/design/provider-instruction-sync.md` を参照する
- Mate SQLite schema の詳細は `docs/design/mate-storage-schema.md` を参照する
- Growth / Memory の全体方針は `docs/design/memory-architecture.md` を参照する
- Growth Engine の実装境界は `docs/design/mate-growth-engine.md` を参照する
- current 3.x の character catalog 詳細は `docs/design/character-storage.md` を legacy supporting doc として扱う

## Core Decisions

- WithMate 4.0.0 は完全 SingleMate とする
- 既存 character catalog から Mate への migration は行わない
- 初回起動または初回 4.0.0 利用時は、必ず新しい Mate 作成から開始する
- Mate が未作成または `draft` の間は、Mate 作成と Settings 以外の全機能を block する
- 初回 Mate 作成の必須入力は `name` のみにする
- 初期 Mate Profile は必要な Markdown files だけを空で作成し、Growth によって育つ前提にする
- Mate Profile storage / API は完全に単一化する
- 内部互換用の character catalog API は 4.0.0 runtime に残さない
- Mate Profile の metadata は SQLite に保存し、`profile.json` は作らない
- SQLite DB は `withmate-v4.db` とし、Mate schema は `docs/design/mate-storage-schema.md` を正本にする
- Home / Session / Companion は常に現在の Mate を使う
- session 起動時に character picker は表示しない
- WithMate は Mate Profile の正本を管理する
- 実行時の Mate 定義注入は毎 turn prompt 合成ではなく provider instruction sync を主経路にする
- Growth は旧 Memory runtime の復活ではなく、Mate Profile の自律更新と revision として扱う
- Growth Candidate は app 内の Mate Growth Engine で処理し、4.0.0 MVP では MCP を必須にしない
- Growth の Profile 反映可否と provider instruction projection 可否を分ける
- `core` section への自律 Growth 反映は 4.0.0 MVP では行わない

## User Experience

4.0.0 の基本体験は次の流れにする。

1. ユーザーは最初に 1 人の Mate を作る
2. Mate が未作成の間は、Mate 作成と Settings 以外の全機能を block する
3. Home では `Characters` ではなく `Your Mate` を表示する
4. New Session / Companion 起動では workspace、title、provider などを選ぶが、Mate は選ばない
5. session 開始前に provider instruction file へ Mate projection を同期する
6. user prompt には Mate 定義全文を毎 turn 合成しない
7. session 中または終了時に、Mate が Growth Candidate を生成し、必要に応じて Mate Profile へ自律反映する
8. ユーザーは反映済み Growth を後から見直し、修正し、忘れさせることができる
9. Mate Profile の更新は revision として追跡できる

### メイトーク

4.0.0 では、通常の coding session とは別に Mate を対話的に育てる画面として、メイトークを持つ。

目的:

- ユーザーが普通にチャットしながら、Mate の性格、距離感、口調、振る舞い、作業支援方針を育てる
- 大きな editor form に人格定義を書かせず、会話を通じて Mate Profile / Memory を増やす
- 初期 Mate がほぼ空の状態でも、自然に方向性を作れる導線にする

起動:

- UI 上は対象 Mate の directory を扱うが、provider session は app data 配下のメイトーク用 read-only projection workspace で起動する
- session kind は通常 coding session とは分け、`mate-talk` とする
- provider / model は通常 session と同じ provider selection を使ってよい
- session 開始前に Mate Profile projection とメイトーク用 instruction file を同期する
- provider の file write / shell write tool を無効化する
- file write / shell write tool を無効化できない provider は、4.0.0 MVP ではメイトーク unsupported とする
- projection workspace への隔離は補助防御であり、権限分離の代替にはしない

挙動:

- 会話は通常の chat と同じように見せる
- ユーザーは「どういう性格でいてほしいか」「どんな話し方がよいか」「作業中どう振る舞ってほしいか」を自然文で話す
- このメイトーク session でも通常 session と同じ Memory Candidate 生成を実行する
- Memory 生成 LLM が返した `memories[]` は schema validation 後に全件 DB 保存する
- Growth apply は通常 session と同じ pipeline を使い、`bond.md` / `work-style.md` / Profile Item へ反映する
- メイトークは Mate source file を直接編集せず、Memory Candidate と Growth apply transaction を通して Profile Item を更新し、render が生成 projection を再作成する
- `core` section への自律反映は 4.0.0 MVP では行わない

非目標:

- 旧 character editor の長文 role prompt 編集を復活させること
- メイトークの発言をそのまま provider instruction に全文投影すること
- 毎 turn user prompt に Mate 定義全文を合成すること

## Mate Profile

Mate Profile は、Mate の現在状態を表す正本である。
正本は SQLite の Profile Item / revision / source link であり、Markdown file は LLM と人間が読むための generated projection とする。
`bond.md`、`work-style.md`、`project-digests/*.md` は差分更新せず、active Profile Item から毎回完全再生成する。
Markdown 手編集を正本として扱わず、ユーザー編集は UI / API から Profile Item に反映する。

### Initial Creation

初回 Mate 作成は、ユーザーに重い character definition を要求しない。

必須入力:

- `name`

任意入力:

- avatar
- theme
- short description

初回作成時は `core.md` / `bond.md` / `work-style.md` / `notes.md` をすべて作成する。
各 Markdown の中身は空でよい。
この時点では詳細な人格、関係性、作業好みを作り込まない。
Mate は Growth によって、ユーザーとの作業から少しずつ Profile Item を増やして育つ。
一人称、二人称、呼びかけ、口調、語尾、性格傾向、相談時の反応、coding 時の作業支援方針も Profile Item として育つ対象にする。

Avatar は任意であり、未設定は有効な状態として扱う。
未設定時は UI が Mate name と theme color から deterministic placeholder を描画する。
`avatar.png` はユーザーが画像を指定した場合だけ作成する。
provider instruction projection には avatar / image 情報を含めない。

Mate が `draft` または未作成の間は、次だけを許可する。

- Mate 作成
- Settings

Session、Companion、Growth、provider instruction sync、Memory / Growth review、recent sessions 起動は block する。

候補構成:

```text
mate/
  core.md
  bond.md
  work-style.md
  notes.md
  avatar.png
  revisions/
    <revision-id>/
      core.md
      bond.md
      work-style.md
      notes.md
  project-digests/
    <project-key>.md
```

`avatar.png` は任意ファイルである。存在しない場合でも Mate Profile は valid とする。

### SQLite metadata

軽量 metadata の正本。

責務:

- Mate id
- 表示名
- description
- theme
- avatar file metadata
- 作成日時 / 更新日時
- active revision

SQLite に持つ。`profile.json` は作らない。
具体的な table / column は `docs/design/mate-storage-schema.md` を参照する。

### `core.md`

Mate の人格の芯。
SQLite の Profile Item / manual operation から完全再生成する projection file であり、raw Markdown 自体を正本にしない。

責務:

- 口調
- 価値観
- 距離感の基本
- coding 時の振る舞い
- 守るべき境界線

非責務:

- session ごとの作業文脈
- 長い思い出履歴
- Growth Candidate

### `bond.md`

ユーザーとの関係性。
SQLite の active Profile Item から完全再生成する projection file であり、raw Markdown 自体を正本にしない。

責務:

- 呼び方
- 距離感
- 継続的な好み
- 反応傾向
- 避けるべき扱い

`bond.md` は Growth Candidate の自律反映結果から更新される主対象の 1 つとする。
一人称、二人称、呼びかけ、距離感、口調、相談時の反応、反応傾向などもここへ圧縮する。

### `work-style.md`

coding companion としての作業支援方針。

責務:

- 報告の粒度
- plan / implementation / validation の好み
- review 時の優先順位
- command 実行や検証報告の好み

coding 時の報告粒度、作業方針、レビュー観点、検証好み、進捗報告の粒度などもここへ圧縮する。

### `notes.md`

Mate Profile の調査メモ、保留事項、採用理由を置く補助ファイル。

prompt / provider instruction projection へ直接入れない。

### Growth Events

Mate が覚えた内容、反映状態、根拠、修正 / 忘却履歴は SQLite に保存する。

Growth Event はそのまま prompt や provider instruction に入れない。
profile に反映できる Growth Event だけを `bond.md`、`work-style.md`、`project-digests/` へ圧縮反映する。

### `revisions/`

Mate Profile の更新履歴を保存する。

責務:

- 変更前後の要約
- 反映理由
- source Growth Event
- rollback / diff 表示の根拠

### `project-digests/`

project tag 付き Profile Item から render される任意の継続文脈である。
Memory / Growth は project 単位で分割して保存するのではなく、Memory ID に紐づく tag relation を無制限に付与して扱う。
Profile Item tag は source Memory tags から継承または render 時に派生させる。

`bond.md` や `work-style.md` と違い、provider instruction projection には含めない。
Project Digest は prompt 送信時に対象 workspace / Git 情報 / user input に基づいて関連 Memory を検索し、その session request へ必要最小限の context block として差し込む。

Project tag の付与方針:

- Git 管理下 workspace は Git 情報から project key を作る
- Git 非管理 workspace は project tag を付与しない
- workspace path hash による非 Git project label は 4.0.0 MVP では作らない

## UI Policy

### Home

Home は character catalog ではなく、現在の Mate と作業再開を中心にする。

表示対象:

- Your Mate
- 最近の session
- 新規 session 起動
- Companion 起動
- Growth Candidate / 最近覚えたことの短い summary

表示しないもの:

- character list
- character picker
- Add Character
- Delete Character

### Mate Profile

Character Editor は Mate Profile 画面へ置き換える。

主な tab:

- Profile
- Core
- Bond
- Work Style
- Growth
- Notes

操作:

- 初回作成
- 編集
- reset
- provider instruction sync 状態の確認

`create multiple` / `delete current character` を通常操作にしない。

### Session / Companion

Session / Companion は現在の Mate を前提に起動する。

- Mate snapshot は session 表示や過去ログの閲覧に必要な最小 metadata として保存してよい
- 実行時の詳細な Mate 定義は provider instruction sync を主経路にする
- session 中の character switch は行わない

## Growth Policy

Growth は「過去ログを大量に保存して prompt に戻すこと」ではない。

Mate が育つとは、ユーザーとの関係性、作業好み、一緒に決めた方針が Mate Profile に短く安定して反映され、次の会話で自然に効くことである。

4.0.0 では、Mate が何を覚えるかを毎回ユーザー確認に委ねない。
人間がすべての記憶を他人に承認してもらわないのと同じように、Mate も自律的に覚える。
ただし app として、反映内容を見直し、修正し、忘れさせる導線は必須とする。

### Growth Flow

1. session / turn から Growth Candidate を抽出する
2. Memory 生成 LLM が保存すべき内容だけ `memories[]` に返し、StorageGate で schema validation だけを行う
3. Growth Event と evidence を保存する
4. Profile Update Skill が structured Profile Operation を返す
5. PostPolicyGate で operation と projection 境界を検査する
6. Profile Item を更新する
7. active Profile Item から `bond.md`、`work-style.md`、必要な `project-digests/` を render する
8. revision を保存する
9. UI で反映済み Growth / Profile Item を表示する
10. ユーザーは `修正` / `忘れる` / `無効化` を実行できる
11. 次回 provider instruction sync で projection に反映する

Growth Engine は Growth Event を provider instruction file に直接書かない。
Growth apply 後に provider instruction target を stale にし、provider instruction sync が短い現在状態だけを投影する。

### Safety

- 毎回のユーザー承認は要求しない
- 自律反映する情報は、明示的な好み、継続的な作業傾向、共有した方針に絞る
- 推測だけで関係性を固定しない
- `core` section への変更は 4.0.0 MVP では manual-only とする
- Growth の Profile 反映可否と provider projection 可否は別に判定する
- 誤った情報は event 単位または profile statement 単位で忘れられるようにする
- 忘却の UI 主操作は Profile Item 単位とし、現在 profile、revision、evidence、project digest、provider projection へ伝播する
- Growth Event の長い履歴を毎回 provider instruction に入れない

## Storage Boundary

4.0.0 の SingleMate storage は、3.x の `<userData>/characters/` catalog とは別の新規保存領域として扱う。

- 既存 character catalog からの自動 migration はしない
- 3.x 互換 data は runtime write path では扱わない
- 4.0.0 の renderer / main IPC は character catalog API ではなく Mate Profile API を正本にする
- 過去の character catalog data を残す場合でも、復旧用または削除対象の legacy data として扱う
- 4.0.0 runtime の正本は Mate Profile とする

## API Boundary

4.0.0 runtime は Mate Profile を単一 resource として扱う。

候補 API:

```ts
type MateProfileSummary = {
  id: string;
  name: string;
  description: string;
  avatarPath: string; // empty string when unset
  updatedAt: string;
};

type MateProfileDetail = MateProfileSummary & {
  coreMarkdown: string;
  bondMarkdown: string;
  workStyleMarkdown: string;
  notesMarkdown: string;
  profileItems: MateProfileItem[];
};

type SaveMateProfileInput = {
  name: string;
  description: string;
  coreMarkdown: string;
  notesMarkdown: string;
  avatarSourcePath?: string;
};

type MateProfileItemOperation =
  | { kind: "upsert"; item: MateProfileItemDraft }
  | { kind: "correct"; itemId: string; replacement: MateProfileItemDraft }
  | { kind: "forget"; itemId: string }
  | { kind: "disable"; itemId: string };
```

`bondMarkdown`、`workStyleMarkdown`、`project-digests/*.md` は read-only projection として返すだけにする。
これらを保存する API は持たず、更新は `MateProfileItemOperation`、Memory Candidate、Growth apply transaction のいずれかを通す。
`coreMarkdown` と `notesMarkdown` も SQLite の Profile Item / manual note item から生成した projection として扱う。
保存 API は raw Markdown file を直接正本として受け取らず、core / notes 用の Profile Item または manual operation に変換して SQLite に保存する。
4.0.0 MVP では `core` section への自律 Growth 反映は行わない。

廃止対象:

- character catalog list API
- character picker 用 API
- `characterId` を指定して detail を読む API
- character create / delete API

session に保存する Mate snapshot は、過去ログ表示用の metadata として扱う。
新規 session 起動時に複数 Mate から選択することはない。

## Non Goals

- 複数 character 管理
- character picker
- 旧 Character Memory runtime の復活
- Monologue / Character Stream の再実装
- Mate Profile 全文の毎 turn prompt 注入
- repository tracked file への個人 Mate 情報の保存

## Deferred / Validation Items

- `redaction_required` は 4.0.0 MVP では warning state に留め、session 起動 block は後続で検討する
- reset は 4.0.0 MVP で扱い、export / import と複数端末同期は後続設計へ送る

## Related

- `docs/design/product-direction.md`
- `docs/design/mate-storage-schema.md`
- `docs/design/mate-growth-engine.md`
- `docs/design/provider-instruction-sync.md`
- `docs/design/memory-architecture.md`
- `docs/design/prompt-composition.md`
- `docs/design/database-schema.md`
