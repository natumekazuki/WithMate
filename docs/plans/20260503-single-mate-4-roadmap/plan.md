# Plan

- task: WithMate 4.0.0 SingleMate roadmap
- date: 2026-05-03
- owner: Codex

## 目的

WithMate 4.0.0 を、複数キャラクターを選択する coding agent wrapper ではなく、1 つの環境に 1 人の Mate が定着して育つ coding companion として再定義する。

この plan は、SingleMate 化、Mate Profile、provider instruction sync、Growth / Memory 再設計を同じ方向へ揃えるための実装ロードマップとする。

## 決定事項

- WithMate 4.0.0 は完全 SingleMate とする。
- 既存キャラクターからの migration は行わない。
- 初回起動または初回 4.0.0 利用時は、必ず新しい Mate 作成から開始する。
- Mate が未作成または draft の間は、Mate 作成と Settings 以外の全機能を block する。
- 初回 Mate 作成の必須入力は `name` のみにする。
- 初回作成時は必要な SQLite row と generated projection file をすべて作成または生成するが、中身は空でよい。
- Mate avatar / icon は任意であり、未設定は有効な状態として扱う。
- Avatar 未設定時は Mate name と theme color から placeholder を描画する。
- WithMate は Mate の管理 UI と正本データを持つ。
- Mate Profile storage / API は完全に単一化し、内部互換用の character catalog API は維持しない。
- Mate Profile の metadata と Profile Item / revision / source link は SQLite に保存し、`profile.json` は作らない。
- `bond.md` / `work-style.md` / `project-digests/*.md` は正本ではなく、SQLite の active Profile Item から毎回完全再生成する projection とする。
- 実行時のキャラクター定義注入は、毎 turn の prompt 合成ではなく provider native instruction file への同期を主経路とする。
- provider instruction sync は、WithMate が current 実装でサポートしている provider だけを MVP 対象にする。
- provider root directory と instruction file path は Settings で指定可能にする。
- provider instruction sync の設定 UI は既存 Settings に追加する。
- repository 配下の共有 instruction ではなく、user / provider root 配下の個人用 instruction file を基本対象にする。
- Growth は旧 Memory runtime の復活ではなく、Mate Profile の更新候補と revision として扱う。
- Memory / Growth は project 単位で分割せず、Memory ID に紐づく tag relation を無制限に付与して扱う。
- tag は `tag_type` と `tag_value` の open string とし、種類数と付与数を schema では制限しない。
- Git 管理下 workspace は Git 情報から project tag を作り、Git 非管理 workspace には project tag を付与しない。
- Growth Candidate は 4.0.0 から実装する。
- Memory Candidate 生成は通常 turn response に含めず、app internal background execution として行う。
- Memory Candidate 生成は同一 provider thread に hidden turn を積まず、familiar-ai の post-response pipeline を参考に別 background session / utility call として実行する。
- Memory 生成 job は app data 配下の `memory-runtime/templates/` と `memory-runtime/runs/{runId}/` を使い、使用 provider ごとの native instruction file をすべて配置する。
- 各 Memory 生成 run は `.lock` を持つ使い捨て workspace として作成し、heartbeat 付き status で active run を識別し、完了後または app 起動時 cleanup で削除する。
- Mate を対話的に育てる `mate-talk` 画面を表示名「メイトーク」として追加し、そこでの会話でも通常 session と同じ Memory Candidate 生成を実行する。
- `mate-talk` の provider session は Mate source directory ではなく app data 配下の read-only projection workspace で起動し、Mate source file への直接 write 権限を持たせない。
- 一人称、二人称、呼びかけ、口調、語尾、性格傾向、相談時の反応、coding 時の作業支援方針も Profile Item として育てる対象にする。
- Memory Candidate 生成は `{ memories: MemoryCandidate[] }` の配列 wrapper を返す。
- Memory Candidate 生成 LLM が返した `memories[]` は schema validation 後に全件 DB 保存する。
- 保存しない判断は LLM が `memories[]` に含めないことで表現する。
- app は保存価値、危険性、重複、forgotten tombstone との意味的な一致を保存前に判定せず、schema validation と DB 整合性だけを行う。
- Memory Candidate は `relation = new | reinforces | updates | contradicts` と `relatedRefs` / `supersedesRefs` / `targetClaimKey` を持ち、既存記憶の強化、更新、矛盾訂正を扱う。
- Memory Candidate 生成は WithMate DB から relevant Memory / Profile Item / forgotten tombstone / tag catalog を取得して明示 input として渡す。
- tag catalog は毎回 background run に渡し、既存 tag の再利用を優先させる。
- 適した既存 tag がない場合だけ、LLM は `newTags` と理由を返し、app 側の正規化 / 類似判定を通して catalog に追加する。
- Relevant Memory Retrieval は 4.0.0 MVP から hybrid retrieval を採用する。
- hybrid retrieval は SQL / tag / claimKey / recency / salience で安全に候補を絞り、embedding similarity で意味近傍を拾い、rule score で rerank する。
- embedding は Codex / Copilot などの AI agent provider ではなく、app internal の local embedding backend で生成する。
- 4.0.0 MVP の embedding backend は初回だけ model を download し、以後は local cache から CPU 実行する。
- 既定 embedding model は `Xenova/multilingual-e5-small` とし、dimension は 384 とする。
- 初回 model download は Settings の明示 download button から開始し、download 完了まで semantic retrieval、embedding generation、embedding similarity rerank は実行しない。
- Memory Candidate 生成そのものは SQL / tag / claimKey retrieval に縮退して実行してよい。
- embedding model cache が missing / failed の場合は SQL / tag / claimKey retrieval に fallback する。
- Memory Candidate / Profile Update / Project Digest 用の Growth LLM execution は purpose ごとの fixed priority list を使い、provider / model / depth を設定できる。
- Memory Candidate 生成は軽量 model / reasoning effort / timeout を設定で制御し、turn ごとの実行を既定候補にする。
- Memory Candidate LLM response は UI に表示せず、schema validation を通ったものだけ DB に保存する。
- Mate が何を覚えるかを毎回ユーザー確認に委ねない。
- Growth は自律的に profile へ反映するが、ユーザーは後から見直し、修正、忘却できる。

## 実装決定ロック

- Mate Profile の正本は SQLite の Profile Item / revision / source link とし、Markdown は完全再生成する projection とする。
- Memory Candidate は schema validation 後に全件保存し、app は保存価値、危険性、重複、forgotten tombstone との意味的一致を保存前に判定しない。
- 4.0.0 MVP の provider instruction sync は Codex / Copilot の current adapter capability で検証できる範囲を対象にし、unsupported provider は対象外にする。
- provider instruction sync の既定は `managed-block` とし、`managed-file` は専用 file をユーザーが明示指定した場合だけ使う。
- Project Digest は provider instruction file に常設せず、prompt 送信時に relevant Profile Item を検索して一時 context として注入する。
- メイトークは file write / shell write を無効化できる provider だけで有効にし、無効化できない provider は unsupported とする。

## 非目標

- 複数キャラクター管理 UI の維持
- 既存 character catalog から Mate への自動移行
- 旧 Character Memory / Monologue runtime の単純復活
- session ごとの character picker
- 毎 turn prompt への Mate 定義全文注入
- tracked repository file への個人 Mate 情報の直接書き込み

## 用語

| Term | Meaning |
| --- | --- |
| Mate | WithMate で 1 環境に 1 人だけ存在する persistent companion |
| Mate Profile | Mate の人格、関係性、作業スタイル、成長状態の正本 |
| Mate Core | Mate の口調、価値観、境界線、coding 時の基本振る舞い |
| Bond Profile | ユーザーとの呼び方、距離感、好み、反応傾向 |
| Work Style | coding agent としての支援方針、報告粒度、検証好み |
| Growth Event | Mate が覚えた内容、反映状態、根拠、修正 / 忘却履歴 |
| Mate Growth Engine | session / companion の観測から Growth Candidate を抽出し、policy gate と revision を通して Mate Profile に圧縮反映する app internal service |
| Provider Instruction Sync | Mate Profile から provider 別 instruction file へ projection を同期する処理 |

## 4.0.0 で目指す体験

1. 初回起動時、ユーザーは 1 人の Mate を作る。
2. Mate 未作成または draft 時は Mate 作成と Settings 以外を block する。
3. Home では character list ではなく、現在の Mate と最近の作業が見える。
4. New Session / Companion 起動では character を選ばず、常に現在の Mate で開始する。
5. WithMate は session 開始前に、選択 provider の instruction file へ Mate projection を同期する。
6. user prompt には、必要最小限の WithMate 実行 marker だけを付ける。
7. session 中や終了時に、Mate が Growth Candidate を生成し、policy gate を通った内容を Mate Profile / Growth Event に反映する。
8. ユーザーは反映済み Growth を後から見直し、修正し、忘れさせることができる。
9. Mate Profile の変更は revision として追跡できる。

## Architecture 方針

### Mate Profile 正本

WithMate の app data 配下に Mate Profile の正本を置く。
正本は SQLite の Profile Item / revision / source link であり、Markdown file は LLM と人間が読むための generated projection とする。

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

`avatar.png` はユーザーが画像を指定した場合だけ作成する任意 file とする。
provider instruction projection には avatar / image 情報を含めない。
`bond.md`、`work-style.md`、`project-digests/*.md` は差分更新せず、active Profile Item から毎回完全再生成する。

### Provider Instruction Target

Settings に provider ごとの root directory と instruction file path を持つ。

候補型:

```ts
type ProviderInstructionTarget = {
  providerId: "codex" | "copilot";
  rootDirectory: string;
  instructionFilePath: string;
  writeMode: "managed-file" | "managed-block";
  enabled: boolean;
  requiresRestart: boolean;
};
```

初期方針:

- 4.0.0 MVP では `managed-block` を既定の write mode にする。
- provider instruction file 全体は user / provider の所有物として扱い、WithMate は marker block 内だけを更新する。
- `managed-file` は専用 file をユーザーが明示指定した場合だけ使う。
- `managed-file` でも WithMate-owned marker がある file だけを更新し、既存 unmanaged file は上書きしない。
- provider root / instruction file は Settings から変更できる。
- path は保存前に検証し、存在しない root は明示的な作成確認を挟む。
- MVP 対象は current 実装でサポートしている provider に限定する。

4.0.0 MVP support matrix:

| Provider | Instruction sync | Memory Candidate background run | メイトーク | 対象条件 |
| --- | --- | --- | --- | --- |
| Codex | 対象 | 対象 | 条件付き対象 | native instruction file、structured output、usage、file write / shell write 無効化を adapter capability で検証できること |
| Copilot | 対象 | 対象 | 条件付き対象 | native instruction file、schema submit tool、usage、file write / shell write 無効化を adapter capability で検証できること |
| その他 | 対象外 | 対象外 | 対象外 | 4.0.0 MVP では unsupported として扱う |

### Instruction Projection

Mate Profile 全文をそのまま書き出さず、provider が安定して扱える短い projection を生成する。

projection に含めるもの:

- Mate Core の要約
- Bond Profile の短い安定情報
- Work Style の短い安定情報
- coding correctness / safety / repository instruction 優先の guard
- Mate Profile を勝手に編集しない規則

projection に含めないもの:

- 長い Growth Event 履歴
- Growth Candidate
- session transcript 全文
- provider に不要な UI 文脈
- repository に保存すべきでない個人情報

## Roadmap

### Phase 0: Design Gate

- [x] `docs/design/product-direction.md` を SingleMate 前提へ更新する
- [x] SingleMate の保存設計を `docs/design/` に追加または既存 character docs を更新する
- [x] provider instruction sync の設計を `docs/design/` に追加する
- [x] Growth / Memory の責務を `docs/design/` で再定義する
- [x] 4.0.0 で移行を行わないことを design に明記する
- [ ] README の 4.0.0 向け更新要否を実装着手時に判断する

### Phase 1: Product Surface

- [ ] package version を 4.0.0 に上げる
- [ ] Mate 未作成または draft 時に Mate 作成と Settings 以外の全機能を block する
- [ ] 初回 Mate 作成 flow は `name` だけで active 化できる
- [ ] 初回 Mate 作成時に core / notes / bond / work_style 用の初期 SQLite row と generated projection file を空状態で作成または生成する
- [ ] avatar 未設定でも placeholder 表示で Mate を active 化できる
- [ ] Home の character list を Your Mate 表示へ置き換える
- [ ] New Session / Companion 起動から character picker を削除する
- [ ] Character Editor を Mate Profile 画面へ置き換える
- [ ] Mate を対話的に育てる `mate-talk` 画面を表示名「メイトーク」として追加する
- [ ] `mate-talk` は app data 配下の read-only projection workspace で provider session を起動する
- [ ] `mate-talk` では provider の file write / shell write tool を無効化し、できない provider は unsupported として provider picker で選択不可にする
- [ ] `mate-talk` では Mate source file を直接編集せず、Memory Candidate と Growth apply transaction 経由で Profile Item を更新する
- [ ] create / delete ではなく initial create / edit / reset を主操作にする
- [ ] session header / avatar / copy を Mate 前提へ変更する

主な実装境界:

- `src/HomeApp.tsx`
- `src/home-components.tsx`
- `src/home-launch-state.ts`
- `src/home-launch-projection.ts`
- `src/home-character-projection.ts`
- `src/CharacterEditorApp.tsx`

### Phase 2: Mate Storage

- [ ] Mate Profile の保存 root を定義する
- [ ] Mate Profile metadata 用 SQLite schema / storage を定義する
- [ ] `withmate-v4.db` / schema version 4 を追加する
- [ ] `core.md` / `notes.md` の読み書きと、`bond.md` / `work-style.md` / `project-digests/*.md` の完全再生成 render を実装する
- [ ] `core` section は 4.0.0 MVP では manual / メイトーク由来 Profile Item だけを source にし、通常 Growth apply の自律更新対象から除外する
- [ ] `bond` / `work_style` / `project_digest` は active Profile Item から完全再生成し、Markdown 差分編集を行わない
- [ ] 任意 file としての `avatar.png` 読み書きと未設定 placeholder を実装する
- [ ] 初回 Mate 未作成状態を検出する
- [ ] 初回 Mate 作成 flow を追加する
- [ ] `mate_profile_revisions.status` / `mate_profile_revision_sections` を実装し、`ready` revision だけを active にできる制約を storage 層で enforce する
- [ ] generated projection file の hash / byte size / written_at を revision section に保存し、起動時 recovery で SQLite snapshot と実 file の不一致を検出する
- [ ] `committing_files` / `failed` revision の recovery を実装し、provider sync が不完全 revision を読まないことを保証する
- [ ] Mate Profile reset 時に provider instruction managed block / managed file から旧 Mate projection を削除または disabled projection に同期し、失敗時は warning と再同期導線を出す
- [ ] existing character storage / catalog API を runtime main path から外す
- [ ] renderer / main IPC を Mate Profile API へ置き換える
- [ ] 4.0.0 MVP では reset のみ実装し、export / import と複数端末同期は後続設計へ送る

主な実装境界:

- `src/character-state.ts`
- `src-electron/character-storage.ts`
- `src-electron/character-runtime-service.ts`
- `src-electron/main-character-facade.ts`
- `src-electron/main-query-service.ts`
- `src-electron/preload-api.ts`
- `src/withmate-window-api.ts`
- `src/renderer-withmate-api.ts`

### Phase 3: Provider Instruction Sync

- [x] Settings に provider instruction target 設定を追加する
- [x] 既存 provider / skill root 系の Settings state と同じ流儀で provider instruction target を保存する
- [x] provider root directory と instruction file path の検証を実装する
- [x] provider instruction target は canonical path で検証し、symlink / junction / `..` / drive letter 差異 / UNC path の escape を拒否する
- [x] provider instruction target が Mate source root、read-only projection workspace、memory-runtime、repository workspace、temporary run directory に入る場合は hard fail にする
- [x] managed-block は WithMate marker block だけを差し替え、既存 user content を変更しない
- [x] managed-block marker の `target_id` / `provider_id` / `write_mode` が保存済み target と一致することを検証する
- [x] marker block が存在しない file には Settings confirmation 後に block を追記する
- [x] duplicate marker / malformed marker / target mismatch は hard fail にする
- [x] managed-file は専用 file をユーザーが明示指定した場合だけ許可する
- [x] Mate Profile から provider projection を生成する
- [ ] adapter capability から Codex / Copilot の instruction sync、structured output / schema submit tool、usage、file write / shell write 無効化可否を検出する
- [x] Codex 向け `AGENTS.md` projection を実装する
- [x] Copilot 向け `copilot-instructions.md` projection を実装する
- [x] unsupported provider は instruction sync 対象外として扱う
- [x] session 起動前に instruction sync を実行する
- [x] sync 結果と再起動要否を UI に表示する

主な実装境界:

- `src/provider-settings-state.ts`
- `src/home-settings-draft.ts`
- `src/home-settings-view-model.ts`
- `src-electron/app-settings-storage.ts`
- `src-electron/main-provider-facade.ts`
- `src-electron/provider-runtime.ts`
- `src-electron/session-runtime-service.ts`
- `src-electron/companion-runtime-service.ts`

### Phase 4: Prompt Composition Cleanup

- [ ] character.md 全文を毎 turn prompt に合成する経路を削除または無効化する
- [ ] user input へ付ける WithMate marker を最小化する
- [ ] provider instruction を優先しつつ、coding correctness と repository instruction を上位に置く guard を入れる
- [ ] prompt / instruction の token 量を計測できるようにする

主な実装境界:

- `src-electron/provider-prompt.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src-electron/session-persistence-service.ts`
- `src-electron/companion-session-service.ts`
- `src/session-state.ts`
- `src/companion-state.ts`

### Phase 5: Growth Candidate

- [x] Growth Engine の設計を `docs/design/mate-growth-engine.md` に固定する
- [x] Growth Event / run / cursor / settings の schema 方針を定義する
- [x] session / turn から Memory Candidate を生成し、Growth apply へつなぐ trigger を決める
- [x] Growth Candidate の自律反映 policy を定義する
- [x] Memory Candidate の配列 wrapper と retention intent を定義する
- [x] 毎 turn 軽量 Memory Candidate 生成と、低頻度 Growth apply を分離する
- [x] Growth apply interval / pending Memory trigger と human-like memory score の方針を定義する
- [x] ChatGPT Pro 検討用 summary を `docs/design/mate-memory-summary.md` に作る
- [x] Mate Growth Engine の service boundary を実装する
- [ ] Growth LLM provider / model / depth の fixed priority list を Settings / storage に追加する
- [ ] GrowthModelPort を stub / fake 可能な契約で実装する
- [ ] GrowthModelPort を通常 turn response とは別の background job として実行する
- [ ] GrowthModelPort は user-facing provider thread を再利用せず、別 background session / utility call として実行する
- [ ] GrowthModelPort background execution は tool-less utility call を優先し、agent session が必要な provider では schema submit tool 以外の file write / shell write / provider instruction write を許可しない
- [x] Memory 生成専用 `memory-runtime/templates/` と provider native instruction files を作成し、保存方針を固定する
- [x] Memory 生成 run ごとに `memory-runtime/runs/{runId}/.lock` 付き workspace を作成する
- [x] Memory 生成 run の `.lock` は atomic create と heartbeat で管理し、stale run は quarantine してから cleanup する
- [x] app 起動時に active heartbeat のない stale / completed / failed な Memory 生成 run workspace を cleanup する
- [ ] GrowthModelPort input は current turn と必要 metadata に限定し、session transcript 全量を渡さない
- [ ] Codex GrowthModelPort では background `outputSchema` を渡す
- [ ] Copilot GrowthModelPort では schema 付き internal submit tool を渡し、tool args を structured output として扱う
- [x] Memory Candidate LLM response は `{ memories: MemoryCandidate[] }` として Zod schema validation を実装する
- [x] Memory Candidate 生成 LLM が返した `memories[]` を schema validation 後に全件保存する
- [x] app 側は保存価値、危険性、重複、forgotten tombstone との意味的な一致を保存前に判定せず、schema validation と DB 整合性だけを行う
- [x] Memory Candidate の `relation` / `relatedRefs` / `supersedesRefs` / `targetClaimKey` を schema validation と storage に反映する
- [x] `mate_growth_event_links` を実装し、Memory 同士の reinforce / update / contradict / supersede link を保存する
- [x] `mate_profile_item_relations` を実装し、apply 後の Profile Item 同士の reinforce / update / contradict / supersede relation を保存する
- [x] Memory Candidate input に relevant Memory / Profile Item / forgotten tombstone / tag catalog を含める
- [x] tag catalog storage / API を実装する
- [x] tag catalog sanitized metadata の全件 snapshot を Memory Candidate background run に毎回渡す
- [ ] 保存すべきでない内容は Memory 生成 LLM が `memories[]` に含めないよう provider native instruction files / prompt に明記する
- [x] `mate_growth_cursors` を実装し、`extraction_cursor` / `consolidation_cursor` / `applied_event_watermark` / `project_digest_cursor` を nullable unique に依存せず管理する
- [x] Memory Candidate の `growthSourceType` を `mate_growth_events.growth_source_type` に保存する
- [x] `type = "profile_item"` の `relatedRefs` / `supersedesRefs` を `mate_growth_event_profile_item_links` に保存する
- [ ] LLM の `newTags` を app 側で正規化 / 類似判定 / duplicate collapse してから catalog に追加する
- [x] `mate_semantic_embeddings` を実装する
- [x] local embedding backend / model cache 設定を Settings / storage に追加する
- [x] Settings に embedding model download button / progress / retry UI を追加する
- [x] 既定 model `Xenova/multilingual-e5-small` の初回 download と local cache 管理を実装する
- [x] temporary download、manifest 検証、active cache 昇格、破損検出、stale 再生成を実装する
- [x] Growth Event / Profile Item / tag catalog の embedding 生成と stale 再生成を実装する
- [x] Relevant Memory Retrieval を SQL filter + embedding similarity + rule rerank の hybrid で実装する
- [x] embedding model cache missing / index recovery 時の `sql_only` fallback を実装する
- [x] invalid Memory Candidate response は DB に保存せず run summary に記録する
- [x] Codex / Copilot background usage を `inputTokens` / `cachedInputTokens` / `outputTokens` / `reasoningOutputTokens` / `totalTokens` に正規化して保存する
- [x] usage が null の場合は token trigger を使わず elapsed time / pending Memory / manual run に fallback する
- [x] Memory Candidate 生成の model / reasoning effort / timeout 設定を実装する
- [ ] Memory Candidate 生成は turn ごとの軽量 background run を既定候補にする
- [x] Growth apply 実行頻度を 1 時間に 1 回を上限とする elapsed time / pending Memory / manual run と token usage 補助 signal で制御する
- [x] ProfileUpdateSkill は internal background job として実装する
- [x] ProfileUpdateSkill の出力を Markdown 全文ではなく structured Profile Operation にする
- [x] `mate_profile_items` / `mate_profile_item_sources` / `mate_forgotten_tombstones` を実装する
- [x] `mate_memory_tags` を実装する
- [x] `mate_memory_tag_catalog` を実装する
- [x] Profile Item claim key / claim value normalization を実装する
- [x] Profile Item apply / render API を実装する
- [x] 一人称、二人称、呼びかけ、口調、語尾、性格傾向、相談時の反応、coding 時の作業支援方針を Profile Item として扱う
- [x] Memory tag relation API / storage を実装する
- [ ] Profile Item tag は source Memory tags から継承または render 時に派生させる
- [ ] Git 管理下 workspace の Git 情報から project tag を付与する
- [ ] Git 非管理 workspace では project tag を付与しない
- [x] Project Digest は provider instruction に常設せず、prompt 送信時に workspace / Git 情報 / user input で relevant Profile Item を検索して一時 context として注入する
- [x] Project Digest の prompt injection は `projection_allowed = 1`、active Profile Item、active tag catalog、project tag、token budget、audit record を契約として実装する
- [x] Growth Event は Project Digest prompt injection の直接出力対象にせず、Profile Item / Project Digest apply の evidence に留める
- [x] GrowthPolicyGate を Profile apply / provider projection 用に実装する
- [x] StorageGate は schema validation と DB transaction だけを行い、保存価値の意味判定をしない
- [x] PostPolicyGate は Profile apply / provider projection 直前の検査として実装する
- [x] Growth evidence に source role / source kind / trust level を保存する
- [x] statement fingerprint / forgotten tombstone を実装し、保存前 dedupe は行わない
- [x] recurrence / salience / recency / decay を storage と policy gate に反映する
- [ ] Growth apply / correct / forget / disable の単一 writer lock を実装する
- [ ] Growth apply transaction の idempotency key を実装する
- [ ] Growth apply は final commit 前に current Profile Item / Growth Event state / cursor を更新せず、proposed Profile Item set から projection snapshot を生成する
- [ ] Growth apply revision は `committing_files` / `ready` state を持ち、provider sync は `ready` な SQLite snapshot だけを読む
- [ ] `mate_profile_revisions.status` は `staging` / `committing_files` / `ready` / `failed` を持ち、`active_revision_id` は `ready` revision だけを指す
- [ ] final commit で current Profile Item、Growth Event state、source link、`active_revision_id`、`profile_generation`、cursor を同時に更新する
- [x] provider sync の read snapshot 境界を実装する
- [ ] forget 後の `redaction_required` は 4.0.0 MVP では warning state として扱い、session 起動は block しない
- [x] `projection_allowed` と provider instruction projection gate を実装する
- [x] `core` section の operation は `manual` / `mate_talk_explicit` のみ許可し、`growth_auto` 由来を PostPolicyGate で拒否する
- [ ] 自律反映された Growth Event を最小管理 UI に表示する
- [ ] `修正` / `忘れる` / `無効化` の操作を追加する
- [ ] Growth Event を Bond Profile / Work Style / project tag 付き digest に反映する
- [ ] Growth 反映時に Mate Profile revision を作る
- [ ] 4.0.0 MVP では `changes.patch` を保存せず、diff は snapshot から必要時生成する

### Phase 6: Validation

- [ ] 初回 Mate 作成から session 起動までを手動検証する
- [ ] Mate 未作成または draft 時に Mate 作成と Settings 以外が block されることを検証する
- [ ] Codex instruction sync の反映タイミングを検証する
- [ ] Copilot instruction sync の反映タイミングを検証する
- [ ] provider root が存在しない / 書き込み不可の場合の recovery を検証する
- [ ] provider instruction target の canonical path escape、unmanaged file、marker mismatch を検証する
- [ ] Mate Profile 更新後の session 再起動要否を検証する
- [ ] Growth Candidate の誤抽出時に後から修正 / 忘却できることを検証する
- [ ] Memory Candidate LLM が返した `memories[]` は schema valid なら全件保存され、forgotten tombstone は Memory 生成 input / instruction により再抽出を抑制することを検証する
- [ ] Memory 生成 run の `.lock` / heartbeat / stale quarantine / cleanup を検証する
- [ ] tag catalog sanitized metadata 全件 snapshot により既存 tag が再利用されることを検証する
- [ ] embedding model download button、download 進捗、retry、cache missing / failed 時の SQL-only fallback を検証する
- [ ] `mate-talk` が Mate source file を直接編集できず、Memory Candidate / Growth apply 経由で Profile Item を更新することを検証する
- [ ] Project Digest が provider instruction file に常設されず、prompt request の一時 context にだけ注入されることを検証する
- [ ] Growth apply 中の crash recovery で `committing_files` revision が復旧され、provider sync が `ready` snapshot だけを読むことを検証する
- [ ] Growth Review UI が承認 queue ではなく、検索 / 最近覚えたこと / 忘却 / 無効化に絞られていることを確認する
- [ ] personal instruction file が repo に混ざらないことを検証する
- [ ] package 4.0.0 build / typecheck / targeted tests を通す

## Deferred / Validation Items

- provider instruction target の default path は 4.0.0 MVP では候補提示に留め、最終設定はユーザー確認を必須にする
- Copilot provider が user root instruction をどのタイミングで読むかは targeted validation で実測する
- SQL Memory retrieval MCP は 4.1 以降の read-only interface として残す
- `forget` の UI 主操作は Profile Item 単位にし、event 単位の詳細操作は後続へ送る
- Mate reset は 4.0.0 MVP で扱い、export / import と複数端末同期は後続設計へ送る

## Targeted Test Candidates

- `scripts/tests/character-state.test.ts`
- `scripts/tests/character-runtime-service.test.ts`
- `scripts/tests/home-character-projection.test.ts`
- `scripts/tests/home-launch-state.test.ts`
- `scripts/tests/home-launch-projection.test.ts`
- `scripts/tests/provider-prompt.test.ts`
- `scripts/tests/session-runtime-service.test.ts`
- `scripts/tests/session-persistence-service.test.ts`
- `scripts/tests/companion-session-service.test.ts`
- `scripts/tests/companion-runtime-service.test.ts`
- `scripts/tests/preload-api.test.ts`
- `scripts/tests/main-ipc-registration.test.ts`
- `scripts/tests/mate-storage-schema.test.ts`
- `scripts/tests/mate-profile-storage.test.ts`
- `scripts/tests/mate-growth-storage.test.ts`
- `scripts/tests/mate-profile-item-storage.test.ts`
- `scripts/tests/mate-growth-policy-gate.test.ts`
- `scripts/tests/mate-growth-post-policy-gate.test.ts`
- `scripts/tests/mate-growth-source-trust.test.ts`
- `scripts/tests/mate-growth-forget-redaction.test.ts`
- `scripts/tests/mate-growth-projection-boundary.test.ts`
- `scripts/tests/provider-instruction-target-storage.test.ts`

## 検証方針

- まず docs / projection / storage の単体テストを優先する。
- provider ごとの実反映は manual checklist に残し、session 起動前後で確認する。
- prompt token 量は旧 character prompt 合成と比較できる形にする。
- Growth は精度だけでなく、後から見直し、修正、忘却できることを最優先で検証する。

## 完了条件

- 4.0.0 の product direction が SingleMate として明文化されている
- 初回 Mate 作成 flow が存在する
- Mate 未作成または draft 時に Mate 作成と Settings 以外の全機能が block される
- 初回 Mate 作成は `name` だけで完了できる
- avatar 未設定でも Mate 作成、Home 表示、session 起動が完了する
- character picker / character list が main UI から消えている
- runtime API が character catalog ではなく Mate Profile 単一 API を使っている
- Mate Profile が WithMate から編集できる
- provider instruction file に Mate projection が同期される
- session prompt に Mate 定義全文を毎 turn 合成しない
- Growth Candidate が 4.0.0 で自律反映され、後から見直し / 修正 / 忘却できる
- Memory Candidate 生成が background execution として動き、返却された `memories[]` が DB に保存される
- tag catalog、hybrid retrieval、local embedding cache、SQL-only fallback が実装されている
- Growth apply は Profile Item / revision / generated projection / provider target stale を一貫した transaction として扱う
- `mate-talk` が Mate source file を直接編集せず、Profile Item / Growth pipeline で Mate の振る舞いを育てられる
- Codex / Copilot の最低限の instruction sync 検証が完了している
