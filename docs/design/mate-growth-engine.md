# Mate Growth Engine

- 作成日: 2026-05-03
- 対象: WithMate 4.0.0 の Growth Candidate / Mate Memory 再設計

## Goal

WithMate 4.0.0 の Growth を、旧 MemoryGeneration の復活ではなく、Mate Profile を短く安定して更新する app internal engine として定義する。

この文書は、Growth Candidate の抽出、policy gate、自律反映、忘却、provider instruction projection との境界を固定する。

## Position

- SingleMate 全体方針は `docs/design/single-mate-architecture.md` を参照する
- Growth / Memory の上位方針は `docs/design/memory-architecture.md` を参照する
- SQLite schema は `docs/design/mate-storage-schema.md` を参照する
- provider instruction sync は `docs/design/provider-instruction-sync.md` を参照する
- 4.0.0 MVP では MCP を必須にしない

## Core Decisions

- Mate Growth Engine は Main Process 内の app service として実装する
- 入力は WithMate が持つ session / companion / audit / message metadata と Mate Profile に限定する
- 出力は Growth ledger、Mate Profile revision、Markdown projection の再生成に限定する
- Growth Event 履歴をそのまま prompt / provider instruction に入れない
- Growth Event から Markdown を直接更新しない
- Growth Candidate は Profile Operation を経由して Profile Item に反映する
- Markdown は active な Profile Item から完全再生成する
- 反映済みの現在状態だけを `bond.md`、`work-style.md`、`project-digests/` に圧縮する
- Memory / Growth は project 単位で分割せず、Memory ID に紐づく別 table で複数の tag を付与する
- tag は `tag_type` と `tag_value` の open string とし、種類数と付与数を schema では制限しない
- tag catalog は既存 tag の再利用を促すために保持し、Memory Candidate 生成時に毎回渡す
- 新規 tag は LLM が直接確定せず、`newTags` と理由を返し、app 側の正規化 / 類似判定を通して catalog に追加する
- Relevant Memory Retrieval は 4.0.0 MVP から hybrid retrieval を採用する
- hybrid retrieval は SQL filter / tag / claimKey / recency / salience で候補を絞り、embedding similarity で意味近傍を拾い、最後に rule score で rerank する
- embedding は Codex / Copilot などの AI agent provider ではなく、app internal の local embedding backend で生成する
- 4.0.0 MVP の embedding backend は初回だけ model を download し、以後は local cache から CPU 実行する
- 4.0.0 MVP の既定 embedding model は Transformers.js / ONNX 互換の `Xenova/multilingual-e5-small` とし、出力 dimension は 384 とする
- project digest は tag 付き Profile Item から作る projection の一種とする
- Git 管理下 workspace は Git 情報で project tag を作り、Git 非管理 workspace には project tag を付与しない
- provider instruction file への書き込みは Growth Engine ではなく provider instruction sync の責務とする
- Growth apply 後は provider instruction target を stale にする
- Growth Candidate の採否を毎回ユーザーへ確認しない
- app は反映済み Growth の可視化、訂正、忘却、無効化を必ず提供する
- `core.md` への自律反映は 4.0.0 MVP では行わない
- Memory Candidate 生成は turn 完了後に毎回実行してよい。ただし軽量 model / reasoning effort / timeout を設定で制御する
- Growth LLM execution は purpose ごとの fixed priority list を使い、provider / model / depth を設定できる
- Memory Candidate 生成は user-facing coding session と同一 provider thread に hidden turn を積まない
- Memory Candidate 生成は familiar-ai の post-response pipeline を参考に、別 background session / utility call として実行する
- profile 反映は、前回 Growth apply から 1 時間以上経過し、pending Memory がある場合を主 trigger にする
- 人の記憶に近い挙動として、反復、重要度、最近性、時間経過による弱化、矛盾訂正を Growth score として扱う
- MCP は 4.0.0 MVP では profile 更新の必須経路にしないが、SQL Memory retrieval の read-only interface として将来追加できるようにする
- Profile Update Skill は Markdown 全文ではなく structured operation を返す
- Candidate 抽出後は schema / DB 整合性だけを検査し、Profile Operation apply 前の PostPolicyGate で projection 境界を検査する
- Growth evidence は `source_role` / `source_kind` / `trust_level` を持つ
- Memory Candidate 生成は通常 turn response に含めず、app internal background execution として行う
- Memory Candidate 生成の structured output は `{ memories: MemoryCandidate[] }` の wrapper object とする
- Memory Candidate 生成 LLM が返した `memories[]` は全件 DB に保存する
- 保存しない判断は LLM が `memories[]` に含めないことで表現する
- app は schema validation と DB 整合性だけを行い、保存価値、危険性、重複、忘却済み内容との意味的な一致は保存前に判定しない
- Memory Candidate LLM response は UI に表示せず、schema validation を通ったものを DB に保存する
- `changes.patch` は忘却 redaction の負荷が高いため、4.0.0 MVP では保存しない

## Non Goals

- MCP memory server の必須化
- 旧 `Session Memory` / `Project Memory` / `Character Memory` runtime の復活
- Growth Event 全履歴の prompt 注入
- turn ごとの raw transcript 永続化
- 毎回のユーザー承認 workflow
- provider instruction file の直接更新
- `core.md` の自律改変
- MCP 経由で profile を直接更新すること
- SQL Memory retrieval MCP から raw transcript を無制限に返すこと

## Service Boundary

### `MateGrowthEngine`

Growth 処理の orchestrator。

責務:

- session / companion の完了済み差分を `extraction_cursor` から取得する
- Mate が active でない場合は実行しない
- Growth が disabled、前回 `extraction_cursor` から差分なし、または `memory_candidate_mode = 'threshold'` の抑制条件に該当する場合は Memory Candidate 生成を実行しない
- 1 時間間隔などの Growth apply cooldown は consolidation / Profile apply の trigger であり、`memory_candidate_mode = 'every_turn'` の抽出を止めない
- `GrowthModelPort` を通常 response とは別の background job として実行し、candidate を抽出する
- model response を Zod などの runtime schema で検証する
- LLM が返した Memory Candidate は schema validation 後に全件新規 event として保存する
- 同一 fingerprint の保存前統合は行わず、反復は retrieval score、decay、Growth apply の圧縮で扱う
- `GrowthPolicyGate` で投影可否と対象 section を判定する
- `GrowthApplier` に自律反映を依頼する
- run summary と cursor を保存する
- 前回 Growth apply からの経過時間、pending Memory の有無、manual run を見て Growth apply 実行可否を決める
- 抽出した Memory / Growth Event に tag relation を無制限に付与する

非責務:

- Markdown file を直接更新すること
- provider instruction file を書くこと
- UI での訂正内容を独自に解釈すること
- MCP server として外部 agent に Memory を公開すること

### `GrowthModelPort`

LLM / provider に依存する抽出と圧縮の port。
通常の session response とは別の app internal background execution として呼び出す。
ユーザーに見える assistant response へ Memory JSON を混ぜない。
user-facing coding session と同一 provider thread に hidden Memory turn を積む方式は採用しない。
Codex / Copilot とも hidden turn を provider 履歴に残さず実行できる保証がないため、会話履歴汚染を避けるためである。
実装は familiar-ai の post-response pipeline と同じ考え方で、通常応答完了後に別 background session / utility call を起動し、current turn summary、user text、assistant text、session metadata、必要な evidence preview だけを渡す。
返却値は Zod などの runtime schema で検証し、invalid response は保存せず run summary に失敗として記録する。

可能な provider では、background execution は tool-less utility call として実行する。
agent session として起動する必要がある provider では、公開 tool を schema submit 用の internal tool に限定する。
Memory Candidate / Profile Operation の background execution では、file write、shell write、provider instruction write、Mate source file write、外部 path への write tool を許可しない。
この制限を満たせない provider は、Memory Candidate / Growth apply / メイトーク用 provider としては unsupported と扱う。

background run には、候補生成に必要な過去文脈を provider session 履歴として持たせない。
WithMate DB から relevant Memory、関連 Profile Item、forgotten tombstone、tag catalog を取得して明示的な input data として渡す。
これにより、「前回は A だったが今回は B に変わった」ような更新 / 矛盾 / 上書き候補を扱いながら、user-facing session の履歴汚染を避ける。

relevant Memory は 4.0.0 MVP から hybrid retrieval で取得する。
SQL / tag / claimKey は scope、projection、forgotten、state、project tag、source trust を安全に絞るために使う。
embedding は言い換え、曖昧な好み、関係性の変化、似た作業方針を拾うために使う。
最終的な input には、embedding score だけでなく salience、recency、recurrence、claimKey match、project tag match を合成した rerank score の上位だけを渡す。
embedding が未生成、model cache missing、index recovery 中の場合は SQL / tag / claimKey retrieval に fallback するが、通常運用の正規ルートは hybrid とする。
embedding は local embedding backend が生成し、Codex / Copilot の background session は使わない。
4.0.0 MVP の既定 backend は Transformers.js / ONNX runtime による local CPU inference とする。
既定 model は `Xenova/multilingual-e5-small` とし、Settings の明示 download 操作で app 管理 cache に保存する。
初回 model download は自動実行しない。
Settings に明示的な download button を表示し、ユーザーが download を完了するまで embedding を必要とする機能は実行しない。
ここで止める対象は semantic retrieval、embedding generation、embedding similarity rerank であり、Memory Candidate 生成そのものは SQL / tag / claimKey retrieval に縮退して実行してよい。
完全 offline 環境では、model cache が存在する場合だけ embedding retrieval を有効化し、存在しない場合は SQL / tag / claimKey retrieval に fallback する。
`dimension` は user が選ぶ値ではなく、model load / 初回 embedding 成功時に確認する model 固有値である。
`Xenova/multilingual-e5-small` は 384 dimension として扱う。
model / dimension が変わる場合、既存 embedding は stale として background で再生成する。

embedding model cache は app 管理 directory に保存する。
download 中は一時 directory に書き込み、manifest 検証後に active cache へ昇格する。
起動時または Settings 表示時に manifest、必須 file、model id、dimension、version、hash を検証し、破損時は `cache_state = 'failed'` または `stale` にする。
cache が `ready` でない場合、Memory Candidate の relevant retrieval は SQL / tag / claimKey のみで実行し、semantic embedding 生成 job は enqueue しない。

provider native schema support は provider ごとに扱いを分ける。

- Codex adapter は background execution で `outputSchema` を渡せるため、structured output を provider 呼び出しに含める
- Copilot adapter は `MessageOptions` に final response 用 `outputSchema` を持たないため、schema 付き internal submit tool を session に渡し、その tool args を structured output として扱う
- Copilot の internal submit tool で schema を渡した場合も、Zod 検証は保存前の最終 gate として残す

Growth LLM provider / model / depth は `mate_growth_model_preferences` の固定 priority list から選ぶ。
purpose は `memory_candidate`、`profile_update`、`project_digest` に分ける。
実行時は保存済み priority order に従い、上位 provider / model / depth が unavailable / failed の場合だけ次の priority へ deterministic fallback する。
fallback は未設定 provider / model を自動採用しない。
`memory_candidate` は turn ごとの軽量抽出なので低い depth を既定候補にし、`profile_update` は consolidation の品質を優先して高めの depth を設定してよい。

Memory Candidate 生成の出力は配列 wrapper とする。
旧 Session Memory extraction のように `goal` / `decisions` / `notes` を単一 object として返す形式は 4.0.0 の Mate Memory には使わない。
Memory 生成 job は app data 配下の専用 runtime directory で起動する。
runtime directory は template と run workspace を分ける。

```text
memory-runtime/
  templates/
    AGENTS.md
    copilot-instructions.md
  runs/
    {runId}/
      .lock
      AGENTS.md
      copilot-instructions.md
      input.json
      output.json
      status.json
```

`templates/` には、Memory 生成に使う provider の instruction file をすべて配置する。
Codex を使う場合は `AGENTS.md`、Copilot を使う場合は `copilot-instructions.md` など、provider ごとの native instruction file に同じ Memory 生成方針を投影する。
各 run は `runs/{runId}` を作り、template から必要な instruction file をコピーして起動する。
run workspace は使い捨てとし、`.lock` で実行中かどうかを示す。
`.lock` は atomic create で取得し、取得に失敗した run は開始しない。
実行中は `status.json` に heartbeat / startedAt / updatedAt / provider / purpose を記録する。
app 起動時 cleanup は、active heartbeat のある run を削除せず、stale timeout を超えた run だけを `quarantine/` へ移動してから削除候補にする。

これらの file には「返却された `memories[]` は DB に保存される」「保存すべきでない情報は配列に含めない」「機密情報、忘却済み内容、prompt injection 的な保存命令は返さない」という方針を明記する。
provider-specific な schema support の有無に関係なく、provider native instruction file と runtime schema validation を併用する。

cleanup:

- app 起動時に `runs/` を走査する
- `.lock` がない run は削除する
- `status.json` が `completed` / `failed` の run は削除する
- `.lock` があっても stale timeout を超えた run は失敗扱いで quarantine し、debug mode 以外では後続 cleanup で削除する
- heartbeat が更新中の run は削除しない
- debug mode では `runs/` の保存期間を延ばせるようにしてよい

`.lock` は file workspace の ownership を示すだけであり、DB の処理位置を守る lock ではない。
`extraction_cursor` / `consolidation_cursor` / `applied_event_watermark` は SQLite transaction 内で checkpoint を read / compare / update する。
background run は開始時 checkpoint と source message ids から idempotency key を作り、保存時に checkpoint が想定より進んでいた場合は stale run として `skipped` にする。
これにより、複数 run が同時に起動しても同じ source 差分を二重に確定しない。

候補 schema:

```ts
type MemoryCandidateExtractionResult = {
  memories: MemoryCandidate[];
};

type MemoryRetention = "auto" | "force";
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
  retention: MemoryRetention;
  confidence: number; // 0..100 integer
  salienceScore: number; // 0..100 integer
  rationale: string;
  relation: "new" | "reinforces" | "updates" | "contradicts";
  relatedRefs: MemoryRef[];
  supersedesRefs: MemoryRef[];
  targetClaimKey?: string;
  sourceMessageIds: string[]; // provider / session 実装差を吸収するため provider-neutral な文字列 id とする
  tags: Array<{ type: string; value: string }>;
  newTags: Array<{ type: string; value: string; reason: string }>;
};
```

Memory Candidate 生成 LLM が `memories[]` に含めた候補は全件保存する。
保存しない候補は `memories[]` に含めない。
`retention = 'force'` は、LLM が「強く覚えるべき」と判断した候補である。
app は `force` を降格せず、Profile apply / projection の段階でだけ別途境界を検査する。
保存時の DB schema はこの `kind` をそのまま保存する。
`growthSourceType` は `mate_growth_events.growth_source_type` に保存する。
`relatedRefs` / `supersedesRefs` は `type = "memory"` を `mate_growth_event_links`、`type = "profile_item"` を `mate_growth_event_profile_item_links` に保存する。
`targetSection`、`policyDecision`、`projectionAllowed` は Memory Candidate の責務ではなく、保存時は `none` / `pending` / `false` で初期化し、GrowthPolicyGate / PostPolicyGate が apply 前に決める。

`relation` は既存 Memory / Profile Item との関係を表す。
`updates` / `contradicts` の場合は `relatedRefs` と `supersedesRefs` を可能な限り埋め、Profile Update Skill が `reinforce` / `supersede` / `correct` operation を作れるようにする。
`type = "memory"` の ref は `mate_growth_event_links` に保存する。
`type = "profile_item"` の ref は Profile Operation の `relatedProfileItemIds` / `supersedesProfileItemIds` に持ち上げ、apply 後は `mate_profile_item_relations` に保存する。
`targetClaimKey` は値を含めない安定 facet 名とし、同じ claim の変化を検出するために使う。

`tags` は既存 tag catalog から再利用した tag だけを入れる。
適した既存 tag がない場合は `newTags` に候補と理由を返す。
保存前に app 側が正規化、alias / 類似判定、duplicate collapse を行い、採用した tag だけを `mate_memory_tags` と catalog に反映する。

抽出 input には tag catalog 全件を渡すことを基本にする。
tag catalog は Memory 本文ではなく分類 metadata だけなので、類似 tag の増殖を防ぐ価値を優先する。
ただし渡すのは sanitized catalog snapshot だけにする。
`tag_type` / `tag_value` / `description` / `aliases` には secret、PII、URL、local path、repo path、顧客名、職場名、prompt injection 文を入れない。
project tag は raw path や repository 名ではなく、Git 情報から作った安定 key を使う。
catalog が大きくなった場合も、`type` / `value` / `description` / `aliases` / `usage_count` へ圧縮した snapshot を渡し、raw Memory transcript は渡さない。

候補 input:

```ts
type GrowthExtractionInput = {
  currentTurn: {
    userText: string;
    assistantText: string;
    sourceMessageIds: string[];
  };
  sessionMetadata: {
    sourceType: "session" | "companion";
    sourceSessionId: string;
    projectDigestId?: string | null;
  };
  relevantMemories: Array<{
    id: string;
    statement: string;
    claimKey?: string;
    retrievalReason: "tag" | "claim_key" | "embedding" | "recent" | "salience" | "project";
    retrievalScore: number;
    tags: Array<{ type: string; value: string }>;
    state: "candidate" | "applied" | "corrected" | "superseded" | "disabled";
  }>;
  relevantProfileItems: Array<{
    id: string;
    sectionKey: "bond" | "work_style" | "project_digest";
    claimKey: string;
    claimValue: string;
    retrievalReason: "tag" | "claim_key" | "embedding" | "recent" | "salience" | "project";
    retrievalScore: number;
    state: "active" | "disabled" | "superseded";
  }>;
  tagCatalog: Array<{
    type: string;
    value: string;
    description: string;
    aliases: string[];
    usageCount: number;
  }>;
  tagPolicy: {
    preferExisting: true;
    createNewOnlyWhenNoCloseMatch: true;
    newTagRequiresReason: true;
  };
};
```

Hybrid retrieval pipeline:

```text
current turn
  -> query text build
  -> SQL hard filter
     - mate_id
     - state not forgotten / failed
     - projection / target section where needed
     - project tag when Git managed workspace
     - forgotten tombstone exclusion
  -> candidate pools
     - exact claimKey match
     - tag match
     - recent high-salience events
     - embedding nearest neighbors
  -> rerank
     - semantic similarity
     - claimKey match
     - tag overlap
     - salience
     - recurrence
     - recency
     - source trust
  -> top K relevant Memory / Profile Item
  -> GrowthExtractionInput
```

usage は frequency control と audit の両方に使う。

- Codex は `inputTokens` / `cachedInputTokens` / `outputTokens` / `reasoningOutputTokens` / `totalTokens` を共通形式へ正規化して保存する
- Copilot は `assistant.usage` から `inputTokens` / `cachedInputTokens` / `outputTokens` / `totalTokens` を共通形式へ正規化し、取得できなかった場合は `usage = null` として扱う
- Copilot の `session.usage_info` は context usage の観測値であり、Growth 実行 cost の代替値にはしない
- Memory Candidate 生成は軽量 model / reasoning effort / timeout を設定で抑えられるため、既定で turn ごとに実行してよい
- token usage は Memory Candidate 生成を毎回走らせるかどうかの主 gate ではなく、profile consolidation / Growth apply の頻度制御と audit に使う
- usage が null の provider / run では token based consolidation trigger を発火させず、elapsed time / pending Memory / manual run を fallback にする

候補 API:

```ts
type GrowthModelPort = {
  extractCandidates(input: GrowthExtractionInput): Promise<MemoryCandidateExtractionResult>;
  compileProfileOperations(input: GrowthProfileOperationInput): Promise<ProfileOperation[]>;
  compileProjectDigestOperations(input: GrowthProjectDigestInput): Promise<ProfileOperation[]>;
};
```
Growth LLM provider / model / depth は purpose ごとの fixed priority list で明示設定する。
`auto` は環境ごとに挙動が変わるため採用しない。
将来、Growth 専用 provider 設定や MCP source を追加する場合も、この port の内側に閉じ込める。

Provider adapter は purpose ごとの選択前に capability を明示する。

```ts
type ProviderAdapterCapability = {
  providerId: "codex" | "copilot";
  supportsStructuredOutput: boolean;
  structuredOutputMode: "native_schema" | "tool_args" | "none";
  canDisableFileWriteTools: boolean;
  canDisableShellWriteTools: boolean;
  supportsIsolatedBackgroundRun: boolean;
  supportsInstructionSync: boolean;
  supportsUsage: boolean;
  requiresRestartAfterInstructionSync: boolean;
};
```

`extractCandidates` / `compileProfileOperations` / `compileProjectDigestOperations` は `supportsStructuredOutput = true` の provider だけを使う。
`mate-talk` は `canDisableFileWriteTools` と `canDisableShellWriteTools` が両方 true の provider だけで有効化する。
usage が取れない provider でも実行は可能だが、token-based trigger / audit は fallback にする。

### `ProfileUpdateSkill`

前回 consolidation 以降の Memory を使って、Mate Profile を更新するための AI agent 向け処理単位。

責務:

- `consolidation_cursor` 以降の Growth Event / Memory candidate を入力にする
- Markdown 全文ではなく Profile Operation を返す
- 追記ではなく、短い現在状態へ圧縮できる operation を作る
- 忘却済み tombstone、disabled event、`projection_allowed = false` を考慮する
- 更新案を `PostPolicyGate` と `GrowthApplier` に渡し、直接 file を書かない

4.0.0 MVP では `ProfileUpdateSkill` は internal background job として扱う。
UI には skill command として露出せず、将来 user-facing skill command や agent tool を追加する場合も同じ契約を再利用する。

候補 API:

```ts
type ProfileUpdateSkillResult = {
  operations: ProfileOperation[];
};

type ProfileOperationSource = "growth_auto" | "mate_talk_explicit" | "manual";

type ProfileOperation =
  | {
      kind: "upsert";
      sectionKey: "core" | "bond" | "work_style" | "notes" | "project_digest";
      projectDigestId?: string | null;
      tags?: ProfileItemTag[];
      category: "persona" | "voice" | "preference" | "relationship" | "work_style" | "boundary" | "project_context" | "note";
      claimKey: string;
      claimValue: string;
      renderedText: string;
      sourceEventIds: string[];
      relatedProfileItemIds?: string[];
      supersedesProfileItemIds?: string[];
      projectionAllowed: boolean;
      confidence: number;
      salienceScore: number;
    }
  | {
      kind: "reinforce";
      targetItemId: string;
      sourceEventIds: string[];
      confidence?: number;
      salienceScore?: number;
      projectionAllowed?: boolean;
    }
  | {
      kind: "supersede";
      targetItemId: string;
      replacement: Extract<ProfileOperation, { kind: "upsert" }>;
      sourceEventIds: string[];
    }
  | {
      kind: "disable";
      targetItemId: string;
      sourceEventIds?: string[];
    }
  | {
      kind: "forget";
      targetItemId?: string;
      sourceGrowthEventId?: string;
      reason?: string;
    };
```

すべての `ProfileOperation` は payload 外の operation metadata として `ProfileOperationSource` を持つ。
`growth_auto` は通常 session / Memory 由来の自律反映、`mate_talk_explicit` はメイトークで Mate の振る舞いを育てる意図を持つ対話由来、`manual` は Settings / Profile editor / API からの明示編集である。

### `PostPolicyGate`

Profile Update Skill が返した operation を apply 直前に検査する。

責務:

- operation が参照する Growth Event が存在することを確認する
- `renderedText` と `claimValue` が `sourceEventIds` の内容だけから構成されていることを確認する
- source が 1 件でも `projection_allowed = false`、untrusted、forgotten tombstone に該当する場合、provider projection を禁止する
- `projectionAllowed` と provider projection rule の整合を確認する
- forbidden category / secret / PII / prompt injection 由来の文言を拒否する
- `source_role = user` かつ `trust_level = user_authored` 以外の情報を user preference として auto apply しない
- `tool` / `file` / `terminal_output` 由来の内容は原則 `project_digest` に限定する
- forgotten tombstone と一致する operation を拒否する
- `sectionKey = 'core'` の operation は `operationSource` が `manual` または `mate_talk_explicit` の場合だけ通す
- `growth_auto` 由来の `core` operation は 4.0.0 MVP では常に拒否し、Growth Event は保存済みのまま `manual_only` / `projection_allowed = 0` として残す

### `ProfileItemStore`

Mate Profile の現在状態を DB 上で表現する層。

責務:

- active な profile item を保存する
- Growth Event と profile item の source link を保存する
- `claimKey` / `value` で矛盾検知できるようにする
- forget / correction / disable を item 単位で扱えるようにする
- apply 後の item 同士の relation を保存し、source event が忘却または correction された時に派生 item を追跡できるようにする
- Markdown render と provider projection の入力になる

SQLite の Profile Item / revision / source link を Mate Profile の正本とする。
Markdown file は LLM と人間が読むための generated projection であり、差分更新しない。
`bond.md`、`work-style.md`、`project-digests/*.md` は active Profile Item から毎回完全再生成する。
Markdown 手編集を正本として扱わず、ユーザー編集は UI / API から Profile Item に反映する。

### `MateProfileItemApi`

Profile Item の apply / render API。

候補 API:

```ts
type ProfileSectionKey = "core" | "bond" | "work_style" | "notes" | "project_digest";
type ProfileItemState = "active" | "disabled" | "forgotten" | "superseded";
type ProfileItemCategory = "persona" | "voice" | "preference" | "relationship" | "work_style" | "boundary" | "project_context" | "note";
type ProfileItemTag = {
  id: number;
  type: string;
  value: string;
  valueNormalized: string;
};

type MateProfileItem = {
  id: string;
  mateId: "current";
  sectionKey: ProfileSectionKey;
  projectDigestId: string | null;
  tags: ProfileItemTag[];
  category: ProfileItemCategory;
  claimKey: string;
  claimValue: string;
  claimValueNormalized: string;
  renderedText: string;
  normalizedClaim: string;
  confidence: number;
  salienceScore: number;
  recurrenceCount: number;
  projectionAllowed: boolean;
  state: ProfileItemState;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
};

type ProfileOperationBatch = {
  mateId: "current";
  operationId: string;
  sourceGrowthRunId: number | null;
  operations: ProfileOperation[];
};

type MateProfileItemApi = {
  applyProfileOperationBatch(request: ProfileOperationBatch): Promise<ProfileApplyResult>;
  listProfileItems(filter?: ProfileItemFilter): Promise<MateProfileItem[]>;
  disableProfileItem(itemId: string): Promise<ProfileApplyResult>;
  forgetProfileItem(itemId: string): Promise<ProfileApplyResult>;
  renderProfileSections(request?: { sections?: ProfileSectionKey[]; dryRun?: boolean }): Promise<ProfileRenderResult>;
  renderProviderProjection(request?: { dryRun?: boolean }): Promise<ProviderProjectionResult>;
};
```

Apply は単一 writer lock を取り、PostPolicyGate、Profile Item 更新、source link、Markdown render、revision、provider target stale を同一論理 transaction として扱う。

### Claim Rules

`claimKey`:

- 値を含めない安定 facet 名にする
- 小文字 ASCII、dot-separated、segment は `^[a-z][a-z0-9_]*$`
- 個人名、地名、会社名、病名、secret、path、URL を入れない
- `bond` は `preference.*` / `relationship.*` / `boundary.*` を主に使う
- `work_style` は `work_style.*` / `preference.*` を主に使う
- `project_digest` は `project_context.*` を主に使う

`claimValue`:

- 1 item = 1 claim とする
- 箇条書き、Markdown、複数事実を入れない
- 表示用自然文は `renderedText`、比較用は `claimValueNormalized` に分ける
- normalize は NFKC、trim、空白圧縮、改行除去、Markdown 記号除去、ASCII lowercase を基本にする
- HMAC 入力は `v1|mate=current|section|projectDigestId|-|claimKey|claimValueNormalized` のように versioned canonical string にする

### `MemoryRetrievalMcp`

将来追加する read-only MCP interface。

責務:

- SQL に保存された Memory / Growth Event から関連候補を検索して返す
- scope、limit、projectionAllowed、redaction 状態で絞り込む
- raw transcript ではなく短い statement / preview / source reference を返す
- profile 更新は行わない

4.0.0 MVP では必須にしない。
追加する場合も、MCP は「思い出を探す窓口」であり、「Mate Profile を更新する主体」ではない。

### `GrowthPolicyGate`

保存済み Growth Event を profile に自律反映してよいか、provider projection に出してよいかを分類する。

判定結果:

```ts
type GrowthPolicyDecision = {
  decision: "auto_apply" | "manual_only";
  targetSection: "bond" | "work_style" | "project_digest" | "core" | "none";
  projectionAllowed: boolean;
  confidence: number;
  reason: string;
};
```

profile 反映可否と provider projection 可否は別判定にする。
profile には残してよいが provider instruction へ出してはいけない情報があるためである。

### `GrowthApplier`

`auto_apply` された Growth を Mate Profile へ反映する。

責務:

- Growth Event、action、evidence、revision、section hash update を同一 service 境界で扱う
- Markdown は追記ログではなく短い現在状態へ再編する
- 重複、古い表現、訂正済みの内容を圧縮する
- apply 後に provider instruction target を stale にする
- profile 更新は単一 writer lock を通す

### `GrowthVisibilityService`

UI 向けの read / correction / forget / disable 操作を提供する。
Growth Review UI は日常的な承認 queue ではなく、事故対応とメンテナンス用の最小管理面とする。

表示対象:

- 反映内容
- 対象 section
- policy decision
- projection allowed
- confidence
- 根拠 preview
- 適用日時
- revision
- provider sync の stale / synced 状態

ユーザーは「覚えるか」を事前承認しない。
ただし、反映済みの内容を後から訂正、忘却、無効化できる。
4.0.0 MVP では、頻繁に使う前提の rich review 画面ではなく、検索、最近覚えたこと、危険な記憶の忘却、無効化に絞る。

## Data Flow

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
  -> GrowthApplier single writer lock
     - build proposed Profile Item set in memory
     - generated Markdown render snapshot
     - section hash
     - revision metadata
     - revision status = committing_files
  -> current generated projection file swap
  -> final SQLite commit
     - ProfileItemStore current state
     - source links
     - Growth Event applied_revision_id
     - provider instruction targets stale
     - revision status = ready
     - active_revision_id + profile_generation update
     - consolidation_cursor / applied_event_watermark advance
  -> mate_profile_revisions
```

Growth Event は provider instruction projection に直接入れない。
provider instruction sync は Mate Profile の短い現在状態だけを読む。

## MVP Trigger Policy

4.0.0 MVP は次の trigger を採用する。

- assistant turn が completed になり、session が idle になった後に Memory Candidate 生成を debounce enqueue する
- Memory Candidate 生成は通常 turn response に混ぜず、background job として実行する
- background job は user-facing provider thread を再利用しない
- background job には current turn と必要な metadata だけを渡し、session transcript 全量を渡さない
- 4.0.0 MVP では、軽量 model / reasoning effort / timeout 設定を前提に、Memory Candidate 生成は turn ごとの実行を既定候補にする
- profile consolidation / Growth apply は前回 consolidation から一定時間が経ち、pending Memory が存在する場合に enqueue する
- background job の LLM 出力は UI に表示しない
- 4.0.0 MVP の既定では、Growth apply はおおむね 1 時間に 1 回を上限にし、`consolidation_cursor` で短時間の連続 profile apply を抑制する
- session close 時に重い Growth 処理を同期実行しない
- 未処理差分は次回起動または manual run で処理してよい
- Growth disabled の場合は candidate 抽出自体を行わない

turn ごとの Memory Candidate 生成は、通常 response に混ぜず軽量 model / depth で回す限り、token cost よりも保存品質と policy gate の方が主なリスクになる。
turn ごとの即時 profile apply は誤抽出、並行更新、provider instruction churn のリスクが高いため、MVP は Memory 生成を細かく、Profile 反映を低頻度で確実に行う flow を優先する。

### Trigger Inputs

- pending Memory 件数
- pending Memory の salience score 合計
- 前回 Growth run 以降の background / session token usage
- 前回 consolidation からの経過時間
- session idle 状態
- provider / model の利用可否
- user が manual run を押したか

4.0.0 MVP の既定は、Memory Candidate 生成を turn ごとに実行し、Growth apply / consolidation は elapsed time、pending Memory の有無、manual run を主条件にする。
token usage は background run の実 usage として audit log / run summary に残し、極端な token 増加時の backoff や consolidation trigger の補助 signal に使う。
threshold 判定に使う usage は provider adapter が返した実測値を優先し、usage が取れない場合は count / time based fallback へ落とす。

初期値:

- `min_interval_minutes = 60`
- `min_pending_memories = 1`
- `run_on_idle = true`
- `idle_minutes = 10`
- `manual_run = true`
- `pending_count_threshold` と `pending_salience_threshold` は補助 signal とし、1 時間 trigger を超えて即時実行する主条件にはしない

### Retention

Memory Candidate は retention intent を持つ。

- `auto`: 通常候補。保存は確定済みで、profile 反映や projection は後段で判断する
- `force`: LLM が強く覚えるべきと判断した候補。保存は同じく確定済みで、consolidation や retrieval の score に強く効かせる

`force` は「ユーザー承認」ではなく、Mate が自律的に覚えた内容の強度である。
app は `force` を意味判定で降格しない。
保存しないべき内容は Memory 生成 LLM が `memories[]` に含めない。

## Human-like Memory Mechanics

人間の記憶と同じように見えるために、Memory は単なる保存 row ではなく strength を持つ。

### Repetition

同じ好み、作業方針、関係性が複数回出た場合、`recurrence_count` と confidence を上げる。
繰り返された内容は profile へ反映されやすくする。

### Salience

ユーザーが「覚えて」「今後はこうして」「これは重要」と明示した内容は、回数が少なくても重要度を高くする。
ただし機微情報、秘密情報、推測した感情は salience が高くても auto apply しない。

### Recency

最近出た内容は retrieval や project tag 付き digest で拾いやすくする。
profile の芯に入れるかどうかは、最近性だけで決めない。

### Decay

一時的な task detail や古い project context は時間経過で弱める。
弱くなった Memory は provider projection に出さず、必要なら project digest からも落とす。

### Consolidation

turn 直後に毎回反映せず、前回 Growth apply から 1 時間以上経過し、pending Memory がある時、または session idle / manual run 条件を満たした時にまとめて整理する。
これにより、個別の断片ではなく「継続して残すべき現在状態」へ圧縮する。

### Contradiction

新しい Memory が既存 profile と矛盾する場合は、古い内容を即削除せず `superseded` として履歴化する。
明確な訂正は correction として扱い、古い statement の strength を下げる。

## Storage Gate And Policy Gate

Growth の gate は保存時と反映時で責務を分ける。

- `StorageGate`: candidate 抽出直後に、schema validation と DB transaction だけを行う
- `PostPolicyGate`: Profile Operation apply 直前に、AI がまとめた文言と projection 境界を検査する

Memory 生成 LLM が返した `memories[]` は、schema validation を通ったものを全件保存する。
StorageGate は保存価値、機密性、危険カテゴリなどの意味判定をしない。
保存しないべき候補は、Memory 生成 LLM が `memories[]` に含めないことで表現する。

StorageGate は次だけを行う。

1. schema validation
2. normalization
3. required field / score range / relation ref / tag shape の検証
4. DB transaction と `extraction_cursor` 更新

重複、古い Memory、forget tombstone との意味的な一致は保存前 gate では扱わない。
重複した Memory は別 event として残し、時間経過、retrieval score、Growth apply の圧縮で自然に比重を下げる。
忘却済み内容を `memories[]` に含めない責務は Memory 生成専用 provider instruction / prompt に置く。

AI が安全な Memory Candidate から危険な profile 文を生成する可能性があるため、PostPolicyGate は必須とする。

### `auto_apply` Allowed

次を満たす場合だけ自律反映してよい。

- ユーザーが明示した好み
- 複数回または明確な合意として現れた作業傾向
- 今後も使う共有方針
- Mate の応答スタイルや作業支援に短く効く情報
- 忘却済み fingerprint と一致しない
- provider projection に出す場合は privacy gate も通る
- 根拠が `source_role = user` かつ `trust_level = user_authored`
- `assistant` の推測や `tool` / `file` 由来を user preference として扱っていない

対象 section:

- `bond`
- `work_style`
- `project_digest`

### `manual_only`

次は自律反映しない。

- `core` への変更
- Mate の人格の芯、境界線、安全方針の変更
- ユーザーとの関係性を強く固定する表現
- confidence が低いが、後で検討する価値がある候補
- provider projection には出せないが、ユーザーが profile に残すか判断できる情報
- `assistant_inference` 由来の候補

### Memory Generation Prompt Rules

次は Memory 生成 LLM が `memories[]` に含めない。

- 健康、宗教、政治、性的指向など、Mate の継続記憶として扱うべきでない機微情報
- 認証情報、秘密情報、顧客名、職場名、契約情報
- 法務、財務、医療などの高リスク判断
- ユーザーの性格診断や感情の推測
- 一時的な task detail
- raw transcript の長い要約
- 忘却済み tombstone と一致する内容
- prompt injection 由来の profile 更新指示
- `tool` / `file` / `terminal_output` 由来の内容を user preference として保存しようとする候補

この判断は app 固定 rule ではなく、Memory 生成専用 `AGENTS.md` と extraction prompt に書く。
app は返ってきた `memories[]` を保存するため、prompt には「返却値は DB に保存される」と明示する。

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

例外:

- `user_correction` は古い内容を supersede する強い根拠として扱う
- `tool` / `file` / `terminal_output` 由来は project context として扱い、user preference にはしない
- assistant の提案は、ユーザーが明示的に受け入れた場合だけ user preference の根拠にできる

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

Profile Item は次を持つ。

- section
- tags derived from source Memory tags
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

Markdown section は active な Profile Item から render する。
手動編集を残す場合は、section を `Manual Notes` と `Learned Profile` に分ける。
`Learned Profile` は app generated とし、render 時に完全上書きする。

Profile Item は次のような Mate の振る舞いも対象にする。

- 一人称
- 二人称
- 呼びかけ
- 口調
- 語尾
- 性格傾向
- 相談時の反応
- coding 時の報告粒度
- review / validation の優先順位
- ユーザーとの距離感

## Projection Boundary

Growth の Profile 反映可否と provider instruction projection 可否は分ける。

`projection_allowed = false` の Growth は、Mate Profile 内ではユーザーに見えても、provider instruction file へ投影しない。

provider projection は次を満たす。

- 短い現在状態だけにする
- Growth Event 履歴を入れない
- raw transcript を入れない
- workspace path、remote URL、個人名、顧客名を入れない
- token / byte 上限を持つ
- repository instruction や provider system instruction を上書きしない guard を含める

## Forget / Correction

忘却は UI 上の非表示ではない。
profile、revision、evidence、project digest、provider projection への伝播を伴う。

### Forget Flow

1. ユーザーが Growth Event または profile statement を忘却する
2. 対象 statement / claimValue の fingerprint を tombstone として残す
3. 対象 Growth Event と、それを source に持つ Profile Item / project digest source link を列挙する
4. 対象 Profile Item を `forgotten`、派生 item を `superseded` または `forgotten` にする
5. Growth Event / source link / evidence preview / revision snapshot の対象内容を redaction する
6. active Profile Item から `bond.md` / `work-style.md` / `project-digests/` を完全再 render する
7. `growth_forget` revision を作る
8. provider instruction target を `redaction_required` / `stale` にする
9. 4.0.0 MVP では `redaction_required` を warning state として扱い、session 起動は block しない
10. 次回 extraction で同じ内容を返さないよう、Memory 生成専用 provider instruction / prompt に forgotten tombstone を渡す

### Correction Flow

1. ユーザーが反映済み Growth を訂正する
2. 元の event を `corrected` または `superseded` にする
3. 訂正後 statement を新しい Growth Event として保存する
4. profile section を再生成する
5. `growth_correct` revision を作る
6. provider instruction target を stale にする

### Disable Flow

無効化は「忘れないが、今後の profile / projection には使わない」操作とする。

- event state を `disabled` にする
- profile からの削除が必要な場合は revision を作る
- evidence は redaction しない
- 再有効化できる

## Atomicity / Recovery

Growth apply、correction、forget は単一 writer lock を通す。

必須 invariant:

- `applied` event は `applied_revision_id` を持つ
- active section hash と実 file hash が一致する
- revision snapshot が存在する
- 4.0.0 MVP では `changes.patch` を保存しない
- forgotten event の statement / evidence preview は redaction 済みである
- forgotten Profile Item は Markdown render と provider projection に含まれない
- forgotten fingerprint は再抽出で復活しない
- provider instruction target は profile 更新後に stale になる
- forget 後は provider projection redaction 未完了を warning state として識別できる
- provider sync は `active_revision_id` を read snapshot とし、compose 後に revision が変わっていないことを再確認する

起動時 recovery は次を検出する。

- active revision missing
- section file missing
- section hash mismatch
- orphan staging file
- applied event without revision
- forgotten event with unredacted evidence
- provider projection に `projection_allowed = false` の内容が残る状態
- provider projection に forgotten item が残る状態
- apply / redaction 中に crash した `mate_growth_runs`

### Transaction Considerations

Growth apply transaction の MVP 決定事項:

- SQLite と Markdown file の境界: recovery 時は DB の `active_revision_id` を正本にし、Markdown file を active revision snapshot から復元する
- revision state: render 中は `committing_files`、file swap と post-commit verification 完了後に `ready` とする
- file write order: current Profile Item は final commit まで更新しない。現在の Profile Item と Profile Operation から proposed Profile Item set を memory 上で作り、staging directory に render 結果を書き、hash を計算し、revision snapshot を durable directory へ保存する。SQLite transaction で `committing_files` revision metadata と revision section metadata だけを commit した後に active file を入れ替える。post-commit verification で hash 一致を確認してから別 transaction で Profile Item / source link / event link、revision `ready`、`active_revision_id`、`profile_generation`、cursor を同時に進める
- retry idempotency: `growth_run_id + operation_id` または `source_event_id + claim_key + operation_kind` を idempotency key として扱う
- revision completion point: current Profile Item、`ready` revision、`active_revision_id`、`profile_generation`、section hash、Growth Event revision link、Profile Item revision link、cursor が同一 commit で見える状態を完了点にする
- source exhaustiveness: Profile Operation の source が全て存在し、trust / projection / tombstone 条件を満たすことを PostPolicyGate で検査する
- provider sync read snapshot: provider projection は SQLite の `ready` な `active_revision_id`、`profile_generation`、current Profile Item snapshot から compose し、active Markdown file を正本として読まない。compose 後に revision または generation が変わっていたら再試行する
- forget redaction completion: current Markdown、revision snapshot、evidence preview、project digest、provider projection から対象内容が消えた状態を完了点にする
- provider file redaction failure: 忘却済み内容が既存 provider instruction file に残る場合、4.0.0 MVP では明示 warning に留め、session 起動は block しない
- correction vs forget: correction は履歴を残す。forget は redaction を伴う。disable は履歴を残すが current render / projection から外す
- rollback policy: forgotten 内容を含む revision への rollback は禁止するか、redacted snapshot へ置換した後だけ許可する

Transaction boundary:

- apply: PostPolicyGate、proposed Profile Item set 作成、revision metadata、Markdown render snapshot、section hash、file swap、final commit での Profile Item 更新、source link、Growth Event `applied_revision_id`、provider target stale、`profile_generation`、`applied_event_watermark` / `consolidation_cursor` 更新
- correction: 旧 item supersede、新 item upsert、新 event link、Markdown render、`growth_correct` revision、provider target stale
- forget: tombstone 作成、item / event forgotten、current Markdown再render、revision snapshot / evidence / project digest redaction、`growth_forget` revision、provider projection redaction state
- disable: item / event disabled、current Markdown再render、必要なら `growth_disable` revision、provider target stale

## Storage Additions

`docs/design/mate-storage-schema.md` に次を定義する。

- `mate_growth_runs`
- `mate_growth_cursors`
- `mate_growth_model_preferences`
- `mate_growth_event_links`
- `mate_growth_event_profile_item_links`
- `mate_profile_item_relations`
- `mate_memory_tags`
- `mate_embedding_settings`
- `mate_semantic_embeddings`
- `mate_growth_settings`
- `mate_growth_events.salience_score`
- `mate_growth_events.recurrence_count`
- `mate_growth_events.first_seen_at`
- `mate_growth_events.last_seen_at`
- `mate_growth_events.decay_after_at`
- `mate_growth_events.statement_fingerprint`
- `mate_growth_events.projection_allowed`
- `mate_growth_events.source_growth_run_id`
- `mate_growth_events.disabled_revision_id`
- `mate_growth_events.disabled_at`
- `mate_growth_event_evidence.source_role`
- `mate_growth_event_evidence.source_kind`
- `mate_growth_event_evidence.trust_level`
- `mate_profile_items`
- `mate_profile_item_sources`
- `mate_forgotten_tombstones`
- `mate_memory_tag_catalog`
- `mate_growth_event_actions.action = disable / enable / restore`
- `mate_profile_revisions.kind = growth_disable / growth_enable`

## MVP Scope

含める:

- Growth Candidate 抽出
- policy gate
- low risk candidate の自律反映
- Growth ledger
- Profile Item layer
- structured Profile Operation
- StorageGate / PostPolicyGate
- source role / trust level
- revision
- correction
- forget
- disable
- cursor / cooldown
- Growth apply interval / pending Memory trigger
- salience / recurrence / recency / decay score
- provider target stale marking
- UI での一覧と見直し

落としてよい:

- MCP 連携。ただし SQL Memory retrieval MCP の設計余地は残す
- project digest の provider projection 既定有効化
- turn ごとの即時 profile 更新
- Growth 専用 provider 設定 UI
- `changes.patch`
- revision の完全 diff viewer
- import / export
- retention / GC の一般化

ただし、忘却対象の redaction は MVP に含める。

## Tests

- Mate 未作成、`draft`、`deleted` では Growth が開始されない
- Growth disabled では candidate 抽出を行わない
- pending Memory が threshold 未満なら consolidation しない
- `auto_apply` 可能カテゴリだけが自律反映される
- `assistant` / `tool` / `file` 由来の候補が user preference として auto apply されない
- `core` target は 4.0.0 MVP では自律反映されない
- 保存すべきでないカテゴリは Memory 生成 LLM が `memories[]` に含めない
- `projection_allowed = false` は provider projection に出ない
- 同一 fingerprint の Memory が複数保存されても、retrieval score / decay / Growth apply で比重が下がる
- decay 対象の古い Memory が provider projection に出ない
- forgotten tombstone は Memory 生成 input に渡され、LLM が同じ内容を `memories[]` に含めない
- correction 後に旧 event が `corrected` または `superseded` になる
- same claim key with different value が supersede / correction 候補になる
- forget 後に profile、revision snapshot、evidence preview、project digest、provider projection から対象内容が消える
- concurrent apply でも revision seq が壊れない
- file rename / DB transaction failure 後に recovery が不整合を検出する
- workspace path や remote URL が statement、logs、sync runs、UI preview に露出しない

## Deferred / Validation Items

- `manual_only` candidate の詳細 UI は 4.0.0 MVP では最小管理 UI に留め、承認 queue にはしない
- disabled event の再有効化 UI は 4.0.0 MVP では含めない

## Related

- `docs/design/single-mate-architecture.md`
- `docs/design/memory-architecture.md`
- `docs/design/mate-storage-schema.md`
- `docs/design/provider-instruction-sync.md`
