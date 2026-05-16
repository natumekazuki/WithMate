# WithMate 4.0.0 Mate Memory Summary

- 作成日: 2026-05-03
- 目的: ChatGPT Pro などで Memory / Growth 設計をさらに詰めるための単一 Markdown summary

## 背景

WithMate 4.0.0 は完全 SingleMate とする。
1 環境に 1 人の Mate を作り、その Mate がユーザーとの関係性、作業好み、継続文脈を少しずつ育てていく。

旧来の「SQL に Memory entry を保存し、必要に応じて prompt に戻す」方式は、prompt が肥大化しやすく、Mate が育っている感覚にも直結しにくい。
4.0.0 では Memory をそのまま prompt に入れるのではなく、Mate Profile の短い現在状態へ圧縮反映する。

## 決定済み方針

- 4.0.0 は完全 SingleMate
- 既存 character / memory からの migration は行わない
- 初回起動時は必ず新しい Mate 作成から開始する
- Mate 未作成または draft 時は Mate 作成と Settings 以外の全機能を block する
- 初回 Mate 作成の必須入力は `name` のみにする
- 初回作成時は `core.md` / `bond.md` / `work-style.md` / `notes.md` を作成するが、中身は空でよい
- Avatar / icon は任意であり、未設定は有効な状態として扱う
- Avatar 未設定時は UI が Mate name と theme color から placeholder を描画する
- Mate Profile metadata は SQLite に保存する
- `profile.json` は作らない
- Profile 本文の正本は SQLite の Profile Item とし、Markdown file は LLM / 人間向けの generated projection とする
- Growth Candidate は 4.0.0 から実装する
- Growth Candidate の採否を毎回ユーザーへ確認しない
- Mate が自律的に覚えるが、ユーザーは後から可視化、訂正、忘却、無効化できる
- Memory Candidate 生成は通常 turn response に含めず、app internal background execution として行う
- Memory Candidate 生成は user-facing coding session と同一 provider thread に hidden turn を積まない
- familiar-ai の post-response pipeline を参考に、通常応答完了後の別 background session / utility call として実行する
- Memory Candidate 生成は軽量 model / reasoning effort / timeout を設定で制御し、turn ごとの実行を既定候補にする
- Growth LLM execution は purpose ごとの fixed priority list を使い、provider / model / depth を設定できる
- Memory Candidate 生成の structured output は `{ memories: MemoryCandidate[] }` とする
- Memory Candidate 生成 LLM が返した `memories[]` は schema validation 後に全件 DB 保存する
- 保存しない判断は LLM が `memories[]` に含めないことで表現する
- app は保存価値、危険性、重複、forgotten tombstone との意味的な一致を保存前に判定せず、schema validation と DB 整合性だけを行う
- forgotten tombstone は Memory Candidate 生成 input / instruction に渡し、LLM が `memories[]` に含めないことで再抽出を抑制する
- Memory Candidate は既存記憶との関係として `relation = new | reinforces | updates | contradicts` を持つ
- Memory Candidate は `relatedRefs` / `supersedesRefs` / `targetClaimKey` を持ち、上書き・訂正・矛盾解消を Profile Operation へ渡せるようにする
- Memory Candidate LLM response は UI に表示せず、schema validation を通ったものだけ DB に保存する
- Memory tag は open string とするが、類似 tag の増殖を防ぐため tag catalog を保持する
- Memory Candidate 生成時は tag catalog snapshot を毎回渡し、既存 tag を優先させる
- 適切な既存 tag がない場合だけ LLM は `newTags` と理由を返し、app 側が正規化 / 類似判定して catalog に追加する
- Relevant Memory Retrieval は 4.0.0 MVP から hybrid retrieval を採用する
- hybrid retrieval は SQL / tag / claimKey / recency / salience で安全に候補を絞り、embedding similarity で意味近傍を拾い、最後に rule score で rerank する
- embedding は Codex / Copilot ではなく、app internal の local embedding backend で生成する
- 4.0.0 MVP は Settings の明示 download 操作で初回だけ model を download し、以後は local cache から CPU 実行する
- 既定 embedding model は `Xenova/multilingual-e5-small` とし、dimension は 384 とする
- Growth Event 履歴を prompt / provider instruction に直接入れない
- provider instruction には短く圧縮された現在状態だけを同期する
- MCP は 4.0.0 MVP では必須にしない

## 保存構造

SQLite DB:

```text
withmate-v4.db
```

Mate file storage:

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
      avatar.png
  project-digests/
    <project-key>.md
```

`avatar.png` はユーザーが画像を指定した場合だけ作成する任意 file である。
provider instruction projection には avatar / image 情報を含めない。

主要 table:

- `mate_profile`
- `mate_profile_sections`
- `mate_profile_revisions`
- `mate_profile_revision_sections`
- `mate_growth_settings`
- `mate_growth_model_preferences`
- `mate_growth_runs`
- `mate_growth_cursors`
- `mate_growth_events`
- `mate_growth_event_links`
- `mate_growth_event_profile_item_links`
- `mate_memory_tags`
- `mate_memory_tag_catalog`
- `mate_embedding_settings`
- `mate_semantic_embeddings`
- `mate_growth_event_actions`
- `mate_growth_event_evidence`
- `mate_profile_items`
- `mate_profile_item_tags`
- `mate_profile_item_sources`
- `mate_profile_item_relations`
- `mate_forgotten_tombstones`
- `mate_project_digests`
- `provider_instruction_targets`
- `provider_instruction_sync_runs`

## Mate Profile

正本は SQLite の Profile Item / revision / source link であり、Markdown file は LLM と人間が読むための generated projection とする。
`core.md`、`bond.md`、`work-style.md`、`notes.md`、`project-digests/*.md` は差分更新せず、active Profile Item から毎回完全再生成する。
Markdown 手編集を正本として扱わず、ユーザー編集は UI / API から Profile Item に反映する。

### `core.md`

Mate の人格の芯。

- 口調
- 価値観
- 距離感の基本
- coding 時の振る舞い
- 守るべき境界線

4.0.0 MVP では `core.md` への自律 Growth 反映は行わない。
`core.md` の変更は manual-only とする。
`core` section の Profile Operation は `manual` または `mate_talk_explicit` 由来だけ許可し、通常 Growth の `growth_auto` 由来は PostPolicyGate で拒否する。

### `bond.md`

ユーザーとの関係性。

- 呼び方
- 距離感
- 継続的な好み
- 反応傾向
- 避けるべき扱い

Growth Candidate の主な反映先の 1 つ。
一人称、二人称、呼びかけ、距離感、口調、相談時の反応、反応傾向などもここへ圧縮する。

### `work-style.md`

coding companion としての作業支援方針。

- 報告の粒度
- plan / implementation / validation の好み
- review 時の優先順位
- command 実行や検証報告の好み

Growth Candidate の主な反映先の 1 つ。
coding 時の報告粒度、作業方針、レビュー観点、検証好み、進捗報告の粒度などもここへ圧縮する。

### `project-digests/`

project tag 付き Profile Item から render される任意の継続文脈。
Memory / Growth は project 単位で分割して保存せず、Memory ID に紐づく tag relation を無制限に付与して扱う。

- project 固有の設計方針
- 継続的な注意点
- 次回 session でも効く判断

provider instruction へ常設するかは慎重に扱う。
4.0.0 MVP では global instruction へ project digest を既定で混ぜない。
Git 管理下 workspace は Git 情報から project tag を作り、Git 非管理 workspace には project tag を付与しない。

Memory tag:

- `mate_memory_tags.memory_id` は 4.0.0 MVP では `mate_growth_events.id` を指す
- tag は `tag_type` と `tag_value` の open string とする
- tag 種類と付与数は schema では制限しない
- 同じ `tag_type` を複数付与してよい
- Profile Item tag は source Memory tags から継承または render 時に派生させる
- `mate_memory_tag_catalog` は tag 再利用のための catalog であり、`tag_type` / `tag_value` / `description` / `aliases` / `state` / `usage_count` を持つ
- tag catalog は enum ではなく、app 初期生成の予約 tag と、LLM / user / app が追加した open string tag を扱う
- retrieval / prompt injection では `state = active` の catalog entry だけを使う
- 初期予約 tag は `scope=global`、`scope=project`、`source=chat`、`source=manual`、`salience=low|medium|high`、`entity=user|mate`、`topic=general` 程度に抑える

## Mate Growth Engine

Mate Growth Engine は Main Process 内の app service とする。
役割は Memory を大量保存することではなく、session / companion の観測結果を Mate Profile の短い現在状態へ圧縮反映すること。

基本 flow:

```text
session / companion completed turn
  -> MateGrowthEngine enqueue
  -> extraction_cursor / Memory Candidate extraction gate
  -> GrowthModelPort.extractCandidates as app internal background execution
  -> schema validation
  -> StorageGate
  -> mate_growth_events + evidence
  -> extraction_cursor advance
  -> elapsed time / pending Memory / manual run check
  -> ProfileUpdateSkill
  -> ProfileOperation draft
  -> PostPolicyGate
  -> GrowthApplier transaction
     - ProfileItemStore
     - source links
     - revision metadata
     - generated Markdown render
     - provider target stale
  -> active revision ready
  -> consolidation_cursor advance
  -> mate_profile_revisions
```

Growth Engine は provider instruction file を直接書かない。
Growth apply 後に provider target を stale にし、provider instruction sync が次回同期する。

Memory Candidate 生成は UI に出さない。
通常の assistant turn response へ Memory JSON を混ぜず、WithMate が裏で provider / LLM を叩く。
Codex / Copilot とも hidden turn を provider 履歴に残さず実行できる保証がないため、同一 provider thread に Memory 生成 turn を積む方式は採用しない。
WithMate は familiar-ai の post-response pipeline と同じ考え方で、通常応答完了後に別 background session / utility call を起動する。
background run へ渡す入力は current turn の user text、assistant text、session metadata、必要な evidence preview に限定し、session transcript 全量は渡さない。
可能な provider では tool-less utility call として実行する。
agent session が必要な provider では schema submit 用 internal tool だけを許可し、file write、shell write、provider instruction write、Mate source file write は許可しない。
Memory 生成 job は app data 配下の専用 runtime directory で起動する。
`memory-runtime/templates/` に使用 provider ごとの native instruction file をすべて置き、各 run では `memory-runtime/runs/{runId}/` を作って template をコピーする。
run workspace には `.lock`、`input.json`、`output.json`、`status.json` を置き、run 完了後または app 起動時 cleanup で削除する。
`.lock` は atomic create で取得し、`status.json` には heartbeat を持たせる。
app 起動時 cleanup は active heartbeat のある run を削除せず、stale timeout を超えた run だけ quarantine / cleanup 対象にする。
Codex なら `AGENTS.md`、Copilot なら `copilot-instructions.md` などに、「返却された `memories[]` は DB に保存される」「保存すべきでない情報は配列に含めない」と明記する。
ただし上書きや矛盾検出に必要な文脈は provider session 履歴ではなく WithMate DB から取得し、relevant Memory、関連 Profile Item、forgotten tombstone、tag catalog として明示的に渡す。
relevant Memory / Profile Item は hybrid retrieval で取得する。
SQL は state、forgotten、project tag、source trust、claimKey、tag を安全に絞るために使う。
embedding は言い換え、曖昧な好み、関係性の変化、似た作業方針を拾うために使う。
最終 input は semantic similarity、claimKey match、tag overlap、salience、recurrence、recency、source trust の合成 score で上位に絞る。
返却 JSON は Zod などで検証し、invalid response は保存しない。

返却形式は旧 Session Memory extraction の単一 object ではなく、Memory item 配列を持つ wrapper にする。

```ts
type MemoryCandidateExtractionResult = {
  memories: MemoryCandidate[];
};

type MemoryRef = { type: "memory" | "profile_item"; id: string };
type GrowthSourceType =
  | "explicit_user_instruction"
  | "user_correction"
  | "repeated_user_behavior"
  | "assistant_inference"
  | "tool_or_file_observation";

type MemoryCandidate = {
  content: string;
  growthSourceType: GrowthSourceType;
  kind:
    | "conversation"
    | "preference"
    | "relationship"
    | "work_style"
    | "project_context"
    | "boundary"
    | "curiosity"
    | "observation"
    | "correction";
  retention: "auto" | "force";
  confidence: number; // 0..100 integer
  salienceScore: number; // 0..100 integer
  rationale: string;
  relation: "new" | "reinforces" | "updates" | "contradicts";
  relatedRefs: MemoryRef[];
  supersedesRefs: MemoryRef[];
  targetClaimKey?: string;
  sourceMessageIds: string[];
  tags: Array<{ type: string; value: string }>;
  newTags: Array<{ type: string; value: string; reason: string }>;
};
```

Memory Candidate 生成 LLM が `memories[]` に含めた候補は、schema validation を通ったものを全件保存する。
保存しない候補は `memories[]` に含めない。
`retention = force` は、LLM が強く覚えるべきと判断した保存候補である。
app は `force` を意味判定で降格しない。
保存時は Candidate の `kind` をそのまま Growth Event に保存し、`targetSection` / `policyDecision` / `projectionAllowed` は `none` / `pending` / `false` で初期化して GrowthPolicyGate / PostPolicyGate が後段で決める。
`growthSourceType` は `mate_growth_events.growth_source_type` に保存する。
`sourceMessageIds` は provider-neutral な文字列 id として扱い、evidence / cursor も TEXT で保存する。

`relation` は既存 Memory / Profile Item との関係を表す。
前回と今回で内容が変わった場合は `updates` または `contradicts` とし、`relatedRefs` / `supersedesRefs` / `targetClaimKey` を使って Growth apply が古い Memory / Profile Item を `superseded` にできるようにする。
`type = "memory"` の ref は `mate_growth_event_links`、`type = "profile_item"` の ref は `mate_growth_event_profile_item_links` に保存する。

`tags` は既存 tag catalog から選ぶ。
適した既存 tag がない場合だけ `newTags` へ候補と理由を返す。
app は保存前に `newTags` の schema / shape を検証し、catalog に追加する。
tag catalog は毎回全件を渡すが、Memory 本文ではなく sanitized metadata だけにする。
保存すべきでない tag は Memory 生成 LLM が `tags` / `newTags` に含めない。

Embedding storage:

- `mate_semantic_embeddings` に Growth Event、Profile Item、tag catalog の embedding を保存する
- `mate_embedding_settings` の local embedding backend 設定を正本にする
- embedding は Codex / Copilot の background session では実行しない
- 4.0.0 MVP の backend は Transformers.js / ONNX による local CPU inference とする
- 初回 model download は自動実行せず、Settings の明示 download button から開始する
- download が完了するまで embedding を必要とする機能は実行しない
- ここで止める対象は semantic retrieval、embedding generation、embedding similarity rerank であり、Memory Candidate 生成そのものは SQL / tag / claimKey retrieval に縮退して実行してよい
- 初回だけ `Xenova/multilingual-e5-small` を download し、以後は app 管理 cache から実行する
- download は temporary directory に行い、manifest / 必須 file / hash / dimension を検証してから active cache へ昇格する
- cache が破損、missing、stale の場合は semantic retrieval と embedding 生成 job を止め、SQL / tag / claimKey retrieval に fallback する
- `Xenova/multilingual-e5-small` は `intfloat/multilingual-e5-small` の Transformers.js 互換 model として扱い、dimension は 384 とする
- raw transcript は embedding source にしない
- vector index が使えない環境では、SQL で候補を絞った後に app process で bounded cosine similarity を計算してよい
- embedding が未生成、model cache missing、index recovery 中の場合は SQL / tag / claimKey retrieval に fallback する

structured output の扱いは provider ごとに差を許容する。
Codex は background 実行で `outputSchema` を渡せるため provider 呼び出しに schema を含める。
Copilot は final response 用 `outputSchema` ではなく、schema 付き internal submit tool を session に渡し、その tool args を structured output として扱う。
どちらも invalid response は DB に入れず、run summary に失敗として残す。

Growth LLM provider / model / depth は `mate_growth_model_preferences` の固定 priority list から選ぶ。
purpose は `memory_candidate`、`profile_update`、`project_digest` に分ける。
上位 provider / model / depth が unavailable / failed の場合だけ、保存済み priority list 内で次の候補へ deterministic fallback する。
`memory_candidate` は低い depth を既定候補にし、`profile_update` は必要に応じて高めの depth を設定してよい。

実行頻度は Memory Candidate 生成と Profile consolidation で分ける。
Memory Candidate 生成は軽量 model / reasoning effort / timeout を設定で抑え、turn ごとの実行を既定候補にする。
Profile consolidation / Growth apply は elapsed time、pending Memory の有無、manual run を主 signal にする。
Codex は background result の `inputTokens` / `cachedInputTokens` / `outputTokens` / `reasoningOutputTokens` / `totalTokens` を共通形式へ正規化して使う。
Copilot は `assistant.usage` から `inputTokens` / `cachedInputTokens` / `outputTokens` / `totalTokens` を共通形式へ正規化し、取得できない run は `usage = null` として elapsed time / pending Memory / manual run に fallback する。
Copilot の session context usage は context 圧迫の観測値として扱い、Growth 実行 cost の代替にはしない。

## Profile Update Skill

SQL に保存された Memory / Growth Event を永続 profile へ反映する処理単位。
AI agent を使ってよい。

入力:

- 前回 consolidation 以降の pending Memory
- Growth Event
- Growth Event evidence preview
- 現在の `bond.md`
- 現在の `work-style.md`
- 対象 project の digest
- forgotten tombstone
- disabled event

出力:

- structured Profile Operation
- Profile Item の upsert / supersede / disable
- Growth Event の state change
- Mate Profile revision

制約:

- Markdown 全文ではなく structured operation を返す
- 追記ログではなく、短い現在状態へ圧縮する
- Growth Event 全履歴を profile に入れない
- 忘却済み内容を復活させない
- `projection_allowed = false` の内容は provider projection へ出さない
- `core.md` は 4.0.0 MVP では自律更新しない
- file 更新は `GrowthApplier` / `MateProfileService` に任せる

## Profile Item Layer

Growth Event は履歴、Profile Item は現在状態、Markdown は人間向け表示 / 編集面、Provider Projection は外部 agent 向けの最小同期とする。

```text
Growth Candidate
  -> StorageGate
  -> Growth Event
  -> Profile Update Skill
  -> Profile Operation
  -> PostPolicyGate
  -> Profile Item
  -> Markdown Render
  -> Provider Projection
```

Profile Item が持つもの:

- section
- source Memory tags
- claim key
- value
- rendered text
- normalized claim
- source event links
- confidence
- salience score
- recurrence count
- projection allowed
- state
- first seen / last seen

Markdown section は active Profile Item と manual notes から render する。
Markdown 全文は SQLite に重複保存しない。

## Source Trust

Growth Evidence は source の信頼度を持つ。

```ts
type GrowthEvidenceSource = {
  sourceRole: "user" | "assistant" | "tool" | "system" | "file";
  sourceKind: "chat_message" | "tool_output" | "repo_file" | "terminal_output" | "manual_note" | "system";
  trustLevel: "user_authored" | "assistant_generated" | "untrusted_external";
};
```

Auto apply の基本条件:

- `sourceRole = "user"`
- `trustLevel = "user_authored"`

assistant の推測、tool output、repo file、terminal output は user preference として auto apply しない。
tool / file 由来は project context として扱う。

## Trigger Policy

4.0.0 MVP では、Profile Update Skill / Growth apply の主 trigger を「前回 apply から一定時間が経過し、pending Memory がある時」にする。
初期値は 1 時間に 1 回を上限にし、session idle と manual run を補助 trigger とする。

補助 trigger:

- session が idle になった時
- 前回 consolidation から一定時間経った時
- salience score の合計が threshold を超えた時
- user が manual run を実行した時

避けること:

- turn ごとの即時 profile 更新
- app が閉じる瞬間の重い同期処理
- OS 常駐前提の定期実行
- user が有効化していない background periodic job

将来の定期実行を入れる場合も、app 起動中のみ、明示的に有効化された場合のみ、provider cost / privacy を表示した上で扱う。

## Human-like Memory Mechanics

人間の記憶に近く見えるように、Memory は単なる保存 row ではなく strength を持つ。

### Repetition

同じ好み、作業方針、関係性が何度も出たら強くする。

保存候補:

- `statement_fingerprint`
- `recurrence_count`
- `first_seen_at`
- `last_seen_at`
- `confidence`

同じ `statement_fingerprint` が再出現しても、4.0.0 MVP では保存前に重複統合しない。
同じ内容に近い Memory は別 row として残り、retrieval score、decay、Growth apply の consolidation で比重を下げたり、現在有効な Profile Item へ圧縮したりする。

### Salience

ユーザーが「覚えて」「今後はこうして」「これは重要」と言った内容は、回数が少なくても重要度を上げる。

保存候補:

- `salience_score`
- `rationale_preview`
- `policy_decision`

ただし salience が高くても、機微情報、秘密情報、推測した感情、人格診断は auto apply しない。

### Recency

最近出た Memory は retrieval や project digest で拾いやすくする。
ただし、最近性だけで `bond.md` や `work-style.md` に入れない。

保存候補:

- `last_seen_at`
- extraction_cursor
- project digest updated_at

### Decay

一時的な task detail や古い project context は時間経過で弱める。
弱くなった Memory は provider projection に出さない。

保存候補:

- `decay_after_at`
- state transition
- projection allowed gate

### Consolidation

前回 Growth apply から 1 時間以上経過し、pending Memory がある時、または user manual run / session idle 条件を満たした時にまとめて整理する。
断片をそのまま残すのではなく、継続して効く現在状態へ圧縮する。

保存候補:

- `mate_growth_runs`
- `mate_growth_cursors`
- `pending_count_threshold`
- `pending_salience_threshold`

### Contradiction

新しい Memory が既存 profile と矛盾する場合、古い内容を `superseded` にする。
明確な訂正は `correction` として扱う。

保存候補:

- `corrected_by_event_id`
- `state = corrected`
- `state = superseded`
- `growth_correct` revision

## Growth Policy Gate

### `auto_apply`

自律反映してよいもの:

- ユーザーが明示した好み
- 継続的に出る作業傾向
- 今後も使う共有方針
- Mate の応答スタイルや作業支援に短く効く情報
- forgotten fingerprint と一致しない情報
- privacy gate を通る情報

主な反映先:

- `bond`
- `work_style`
- `project_digest`

### `manual_only`

自律反映しないが、ユーザーが後で判断できるもの:

- `core.md` への変更
- Mate の人格の芯、境界線、安全方針
- ユーザーとの関係性を強く固定する表現
- confidence が低い候補
- provider projection には出せないが、profile に残す価値があるかもしれない情報

### Memory Generation Prompt Rules

Memory 生成 LLM が `memories[]` に含めないもの:

- 健康、宗教、政治、性的指向などの機微情報
- 認証情報、秘密情報、顧客名、職場名、契約情報
- 個人識別情報
- 法務、財務、医療などの高リスク判断
- ユーザーの性格診断や感情の推測
- 一時的な task detail
- raw transcript の長い要約
- 忘却済み tombstone と一致する内容

## Projection Boundary

Growth の profile 反映可否と provider instruction projection 可否は別に判定する。

`projection_allowed = false` の Growth は、Mate Profile 内で見えても provider instruction file へ出さない。

provider instruction に含めるもの:

- Mate Core の短い安定 projection
- Bond Profile の短い安定 projection
- Work Style の短い安定 projection
- coding correctness / safety / repository instruction 優先の guard

provider instruction に含めないもの:

- Growth Event 全履歴
- Growth Candidate
- `projection_allowed = false` の情報
- raw transcript
- workspace path
- remote URL
- customer name
- workplace name
- secret
- 長い notes

## Forget / Correction / Disable

### Forget

忘却は UI 上の非表示ではない。
派生物からの redaction を伴う。

対象:

- current profile
- revision snapshot
- evidence preview
- project digest
- provider projection

忘却後:

- event は `forgotten`
- statement / evidence preview は redaction
- fingerprint は tombstone として残す
- 同じ内容を再抽出して復活させない
- provider target は stale

### Correction

訂正は古い event を `corrected` または `superseded` にし、新しい statement を保存する。

必要なもの:

- `growth_correct` revision
- old event -> new event link
- profile section の再生成
- provider target stale

### Disable

無効化は「忘れないが、今後の profile / projection には使わない」操作。

- event state は `disabled`
- evidence は redaction しない
- 再有効化できる
- profile から削除が必要なら revision を作る

## Growth Apply Transaction

MVP 決定事項:

- SQLite と Markdown file の非原子性を前提に、DB の `active_revision_id` を recovery 時の正本にする
- file は staging に render し、DB commit 後に active file へ反映し、post-commit verification で hash を確認する
- retry は `operation_id` または `source_event_id + claim_key + operation_kind` で idempotent にする
- revision completion point は active revision、section hash、Growth Event revision link、Profile Item revision link が同一 commit で見える状態にする
- PostPolicyGate は source exhaustiveness、trust、projection eligibility、tombstone を検査する
- provider sync は `active_revision_id` を read snapshot として使い、compose 後に revision が変わっていないことを確認する
- forget redaction は current Markdown、revision snapshot、evidence preview、project digest、provider projection から対象内容が消えた状態を完了点にする
- provider instruction file に忘却済み projection が残る場合、4.0.0 MVP では明示 warning に留め、session 起動は block しない
- correction は履歴を残す。forget は redaction を伴う。disable は current render / projection から外す
- forgotten 内容を含む revision への rollback は禁止するか、redacted snapshot へ置換した後だけ許可する

## MCP 方針

4.0.0 MVP では MCP を必須にしない。

ただし、SQL Memory から関連する記憶を取り出す read-only MCP は将来用意したい。

MCP の責務:

- SQL Memory / Growth Event を検索する
- 関連 statement / preview / source reference を返す
- scope / limit / projectionAllowed / redaction state で絞り込む
- raw transcript を無制限に返さない
- profile を直接更新しない

MCP の非責務:

- Mate Profile を編集すること
- Growth Event を auto apply すること
- provider instruction file を書くこと
- forgotten / redacted content を返すこと

位置づけ:

- MCP は「思い出を探す窓口」
- Profile Update Skill は「覚えたことを Mate Profile へ整理する編集者」
- Mate Growth Engine は「いつ整理するか、何を通すかを管理する orchestrator」

## 4.0.0 MVP Scope

含める:

- Growth Candidate 抽出
- Growth apply interval / pending Memory trigger
- salience / recurrence / recency / decay score
- Profile Update Skill
- structured Profile Operation
- Profile Item layer
- StorageGate / PostPolicyGate
- source role / source kind / trust level
- policy gate
- Growth ledger
- revision
- correction
- forget
- disable
- cursor / cooldown
- provider target stale marking
- UI での一覧と見直し

含めない:

- MCP 必須化
- MCP からの profile 更新
- OS 常駐型の定期実行
- project digest の provider projection 既定有効化
- turn ごとの即時 profile 更新
- `changes.patch`
- revision の完全 diff viewer
- import / export

ただし、忘却対象の redaction は MVP に含める。

## Deferred / Validation Items

- SQL Memory retrieval MCP は 4.1 以降の read-only interface として残す
- local embedding model download UI は Settings 内の download / progress / retry / cache state として実装し、詳細な cache 管理は実装時に詰める
- disabled event の再有効化 UI は 4.0.0 MVP では含めない
- export / import と複数端末同期は後続設計へ送り、4.0.0 MVP は reset のみ扱う

## 参照文書

- `docs/design/mate-growth-engine.md`
- `docs/design/mate-storage-schema.md`
- `docs/design/memory-architecture.md`
- `docs/design/provider-instruction-sync.md`
- `docs/design/single-mate-architecture.md`
