# Character Memory Storage

- 作成日: 2026-03-28
- 対象: `Character Memory` の保存設計と reflection cycle

## Goal

`Character Memory` を、coding task の知識とは分離した `関係性記憶` として保存できるようにする。  
current doc では、何を保存し、いつ更新し、何に使うかを固定する。

## Position

`Character Memory` は `Project Memory` や `Session Memory` の延長ではない。

- `Project Memory`
  - 作業対象で再利用する durable knowledge
- `Session Memory`
  - 今の作業を継続する working memory
- `Character Memory`
  - ユーザーとキャラの関係性を継続させるための記憶

`Character Memory` は WithMate の character 価値を支える基盤であり、coding plane の prompt 補強には使わない。

- この文書は `Character Memory` と `character reflection cycle` の detail を持つ supporting doc として扱う
- Memory 全体方針の正本は `docs/design/memory-architecture.md` を参照する
- 独り言 backend の provider 方針は `docs/design/monologue-provider-policy.md` を参照する

## What It Stores

保存対象は `関係性` に限定する。

### 保存するもの

- 呼び方
- 距離感
- ユーザーの明確な好み
- キャラが継続して意識していそうな反応傾向
- 一緒に過ごした出来事として残す価値がある共有体験

### 保存しないもの

- coding task の決定事項
- workspace や project の知識
- session の TODO
- 一時的な雑談だけの断片

## Usage Boundary

`Character Memory` は main の coding session prompt には注入しない。

### 使う先

- `独り言`
- 将来の `character definition update`
- 将来の `relationship summary`

### 使わない先

- main の coding plane prompt
- `Project Memory`
- `Session Memory`

## Reflection Cycle

`Character Memory` と `独り言` は別 trigger にしない。  
共通の `character reflection cycle` を 1 つ持つ。

### Why

- 入力文脈がほぼ同じ
- どちらも `relationship context` を扱う
- trigger を分けると整合が崩れやすい
- 片方だけ更新される状態を避けたい

## Trigger Policy

current v1 では、trigger を次の 2 系統に分ける。

1. `SessionStart`
2. `Context 増加ベース`

### SessionStart

- `独り言` だけ生成する
- `Character Memory` は更新しない
- 目的は、その session を開いた時点での現在感を出すこと

### Context 増加ベース

- `Character Memory` 更新と `独り言` 更新を同時に走らせる
- 共通の `character reflection cycle` はこの経路を正本にする

### Trigger 指標

current v1 の通常 trigger は、前回 reflection 以降の増分で判定する。

- `charDelta >= 1200`
- または `messageDelta >= 6`
- かつ `cooldown >= 5分`

`charDelta` は、前回 reflection 以降の user + assistant 発話文字数の増加量を指す。  
`messageDelta` は、前回 reflection 以降の user + assistant message 数の増加量を指す。

### Suppression

- reflection 実行中は再実行しない
- `SessionStart` は cooldown を無視して実行してよい
- `session close` は trigger に使わない
- Settings の `Memory Generation` global toggle が OFF の時は、`character reflection cycle` 自体を実行しない

この設計では、`独り言のタイミングを流用する` のではなく、  
`Character Memory` と `独り言` の共通 trigger を `character reflection cycle` として持つ。  
ただし `SessionStart` は monologue only の軽量 path として別に置く。

## Input Contract

reflection cycle が読む入力は次に絞る。

1. 直近の user / assistant 会話
2. 既存の `Character Memory`
3. 軽量な `Session Memory` summary

### Input Policy

- coding artifact や file diff をそのまま大量投入しない
- `Project Memory` は原則入力に含めない
- relationship が出やすい発話を優先する

## Output Contract

reflection cycle の出力は 1 つにまとめず、次の 2 系統に分ける。

```ts
type CharacterReflectionOutput = {
  memoryDelta: CharacterMemoryDelta | null;
  monologueText: string | null;
};
```

### Why

- trigger は共通化したい
- しかし保存先と用途は分けたい

## Storage Shape v1

v1 では `Project Memory` と同様に entry 型で保存する。  
ただし scope は project ではなく character 単位に持つ。

### Character Scope

```ts
type CharacterScopeRow = {
  id: string;
  characterId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};
```

### Character Memory Entry

```ts
type CharacterMemoryEntryRow = {
  id: string;
  characterScopeId: string;
  sourceSessionId: string | null;
  category: "preference" | "relationship" | "shared_moment" | "tone" | "boundary";
  title: string;
  detail: string;
  keywordsJson: string;
  evidenceJson: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};
```

## Category Policy

- `preference`
  - 好みや避けたいもの
- `relationship`
  - 距離感、呼び方、関係性の継続情報
- `shared_moment`
  - 一緒に過ごした体験として残すもの
- `tone`
  - 反応傾向、テンション、話し方に効くもの
- `boundary`
  - キャラとして守る距離感や扱い方

## Update Policy v1

最初はかなり保守的にする。

- 明確な関係性変化だけ保存する
- 微妙な推測は保存しない
- 既存 entry と意味が同じなら増やさない
- 同じ出来事の言い換えは merge 候補として扱う

## Retrieval Policy

current milestone では coding plane には使わないため、retrieval は monologue / future update 用に限定する。

- main prompt 用 retrieval はしない
- `独り言` 生成時だけ上位数件を引く
- ranking では `user` 発話を主 query にし、`lastUsedAt ?? updatedAt` を参照する時間減衰を score 補正として入れる

## Current Implementation Slice

current 実装では、まず保存基盤だけを入れる。

- SQLite に `character_scopes` を作る
- SQLite に `character_memory_entries` を作る
- `characterId` 単位で scope を一意に解決する
- session の保存時と app 起動時に scope を同期する
- entry の upsert は exact match 再利用だけを入れる
- `DB を初期化` から `character memory` を個別に消せるようにする

current 実装で入ったもの:

- `SessionStart` の monologue only path
- 文脈増加ベースの `character reflection cycle`
- `CharacterMemoryDelta` の save
- monologue の session `stream` 追記
- right pane `独り言` tab での表示
- background activity / audit 記録
- query-based retrieval / ranking
- `lastUsedAt ?? updatedAt` を使う時間減衰

まだ未実装のもの:

- character definition update への反映

## Non Goals

- coding plane prompt への注入
- task knowledge の保存
- 完全自動の常時実行
- UI からの手動編集

## Related

- `docs/design/memory-architecture.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/product-direction.md`
