# 最適化ロードマップ

- 作成日: 2026-04-13
- 更新日: 2026-04-13
- 対象: WithMate の最適化候補整理

## 目的

WithMate の frontend / backend を通して、現状の処理コストが高い箇所を `1機能 = 1ブランチ` で実装できる粒度に分解する。  
今回の更新では user feedback を踏まえ、Session Window の入力遅延、初期表示時の全データ読込、AuditLog の逐次可視化を roadmap 上の独立論点として再整理する。
この文書は、次の最適化 task を切る時に、候補名・branch 名・対象ファイル・方針・着手順をすぐ参照できる入口として使う。

## ブランチ命名ルール（提案）

- 形式: `opt/<領域>-<機能名>`
- 例:
  - `opt/session-input-responsiveness`
  - `opt/session-persistence-summary-detail-hydration`
  - `opt/session-broadcast-slimming`
- ルール:
  - 1 branch で 1 候補だけを扱う
  - `<領域>` は `session` `renderer` `workspace` `memory` `discovery` など broad な責務名に寄せる
  - `<機能名>` は docs 上の候補名と対応が分かる kebab-case にそろえる
  - 実装中に別の大きな構造問題が見つかった場合は branch を増やして follow-up 化する

## 優先度の考え方

優先度は次の順で判断する。

1. **user pain に直結するか**
   - Session Window の文字入力、初期表示、一覧更新のように、常用フローの体感悪化へ直結するものを最優先にする
2. **初期表示と常時コストを同時に下げられるか**
   - 全件取得、全件 clone、重い hydration のように、window 起動直後から効くものを先に触る
3. **payload / clone の削減幅が大きいか**
   - 巨大 JSON、full row、全 window broadcast のように fan-out が大きいものを優先する
4. **observability / durability の改善を兼ねるか**
   - AuditLog のように、最適化だけでなく実行中の可視性や途中状態保全にも効くものは中優先で前倒しを検討する
5. **局所改善で効果が出るか**
   - index / cache / summary hydration のように、既存責務を崩さず段階導入できるものを先に進める
6. **依存関係が少ないか**
   - snapshot / diff pipeline のような広い変更は、先に軽量なボトルネックを減らした後に着手する

## 最適化候補一覧

| 機能名 | 推奨ブランチ名 | 対象領域 | 主対象ファイル | 現状の非効率ポイント | 最適化方針 | 依存 / 着手順メモ |
| --- | --- | --- | --- | --- | --- | --- |
| Session input responsiveness | `opt/session-input-responsiveness` | Session Window / composer / preview | `src/App.tsx`<br>`src-electron/main-query-service.ts`<br>`src-electron/composer-attachments.ts` | `draft` 変更ごとに `previewComposerInput()` を 120ms debounce で呼び、`@path` 検索時は `searchWorkspaceFiles()` を 100ms debounce で呼ぶ。さらに `getSession()` が active session 取得でも全 session clone を経由し、`resolveComposerPreview()` は `stat()` を伴うため、文字入力と preview / search / query が競合しやすい。 | UI 側では preview / search の発火条件を絞り、入力中は不要な preview 解決を遅延または停止する。main 側では active session lookup を軽量化し、preview 生成を idle / async 優先へ寄せる。`@path` 検索の cache / index 改善はこの branch に含めず、`Workspace file search index` へ分離する。 | user feedback に直結するため最優先の独立候補。broad な renderer 分解ではなく、Session Window 入力経路だけに scope を絞って branch を切る。cache / index 系は後続の `Workspace file search index` branch に委譲する。 |
| Session persistence summary/detail hydration | `opt/session-persistence-summary-detail-hydration` | Electron main / persistence / IPC query | `src-electron/session-storage.ts`<br>`src-electron/main-query-service.ts`<br>`src/session-state.ts`<br>`src/App.tsx`<br>`src/HomeApp.tsx` | `listSessions()` と `getSession()` の両方で `messages_json` / `stream_json` を含む full row を扱い、`getSession()` でも `cloneSessions(this.deps.getSessions()).find(...)` を経由する。`App` と `HomeApp` の初期表示でも全件取得・購読があり、window 起動直後から重い hydration が走る。 | session summary と detail の取得境界を明示し、初期表示では summary のみ読む。session 詳細は window 表示時に hydrate し、clone も summary / detail 単位へ整理する。必要なら DB projection または IPC 契約を分離する。 | 最優先グループ。初期表示の user pain を直接扱い、後続の broadcast slimming の前提になる。 |
| Session broadcast slimming | `opt/session-broadcast-slimming` | Electron main / IPC broadcast | `src-electron/window-broadcast-service.ts`<br>`src-electron/main-broadcast-facade.ts`<br>`src/HomeApp.tsx`<br>`src/App.tsx` | Home / Session の初期購読が full session payload 前提になりやすく、session 変更時も全 window へ重いデータを再送しやすい。初期表示時の全データ読込と、更新時の不要な再描画が連動している。 | session summary broadcast、差分 broadcast、window 種別ごとの配信内容整理を行う。summary/detail hydration と整合するイベント契約に寄せ、renderer 側も一覧用購読と詳細用購読を分離する。 | `Session persistence summary/detail hydration` に続けて着手するのが自然。payload slimming を user-facing な初期表示改善へ接続する候補。 |
| Workspace file search index | `opt/workspace-file-search-index` | Electron main / workspace search | `src-electron/workspace-file-search.ts`<br>`src/App.tsx` | `@path` 検索は 100ms debounce でも scan 側のコストが残ると入力体感へ返ってくる。file index TTL が短く、検索間隔によっては `scanWorkspacePaths()` 由来の全走査コストを頻繁に背負いやすい。 | TTL の見直し、workspace mtime / invalidate 契機ベースの cache、prefix index、直近 query cache を導入し、scan 回数を減らす。UI 側の発火条件調整は `Session input responsiveness` で扱い、この branch では index / cache / invalidation に集中する。 | 入力遅延と隣接するが、branch は分ける。Session Window の体感改善を継続する第 2 段として着手しやすい。 |
| Memory management query optimization | `opt/memory-management-query-optimization` | React renderer / memory UI | `src/memory-management-view.ts`<br>`src/HomeApp.tsx` | search / domain / category / sort のたびに全件 filter / sort を繰り返し、group ごとの再構成も毎回走る。delete / reload のたびに full snapshot を再取得しており、件数増加で UI が重くなりやすい。 | 正規化済み検索キー、domain 別 selector、事前 sort 済み index、必要なら list virtualization を導入する。filter 条件が変わらない時の再利用に加え、full snapshot 再取得を避ける query / mutation 粒度への見直しも行う。 | memory 件数増加時の体感差が出やすい独立候補。renderer 全体分解ではなく、memory 画面の query と描画へ scope を限定する。 |
| Audit log live persistence | `opt/audit-log-live-persistence` | Electron main / audit / Session Window | `src-electron/session-runtime-service.ts`<br>`src/App.tsx` | `phase=running` の row を create した後、完了時・失敗時にまとめ update するため、実行中の内容が永続ログとして追いづらい。UI 側も `listSessionAuditLogs()` の再取得型と live run subscription が分かれており、完了前に読める情報が限定される。 | 実行中イベントを逐次 append または段階 update で永続化し、Session Window は live run と保存済み log を連続した表示モデルで読めるようにする。これは純粋な最適化だけでなく、observability / durability 改善でもあることを明記して進める。 | 中優先。入力遅延・初期表示改善の次に、実行中の読みやすさと障害時の追跡性を上げる候補として独立させる。 |
| Skill/custom agent discovery cache | `opt/discovery-cache` | Electron main / filesystem discovery | `src-electron/skill-discovery.ts`<br>`src-electron/custom-agent-discovery.ts` | discovery が同期 I/O ベースで、session 切り替えや picker 表示ごとに `existsSync` `readdirSync` `readFileSync` を繰り返す。 | workspace 単位の discovery cache、mtime ベース invalidation、非同期 I/O 化を行う。workspace / provider / global source のマージ結果もキャッシュする。 | `Workspace file search index` と同系統の cache 方針で進めるとよい。比較的独立して着手できる。 |
| Memory retrieval indexing | `opt/memory-retrieval-indexing` | Electron main / memory retrieval | `src-electron/project-memory-retrieval.ts`<br>`src-electron/character-memory-retrieval.ts` | retrieval のたびに全 entry を token 化・scoring・sort しており、memory 件数増加で turn 前処理コストが増える。 | entry 側の前処理済み token / fingerprint index を持ち、query 時は candidate 絞り込み後に scoring する。category / updatedAt / keyword の補助 index も検討する。 | `Memory management query optimization` とは別 task。件数が少ない段階では効果が見えにくいので、計測メモを残して進める。 |
| Workspace snapshot / diff pipeline | `opt/workspace-snapshot-diff-pipeline` | Provider runtime / file scan / diff | `src-electron/codex-adapter.ts`<br>`src-electron/snapshot-ignore.ts` | turn 実行時の workspace snapshot capture が全走査ベースで重く、diff 生成も large file / large matrix でコストが高い。snapshot と diff の責務が 1 pipeline に寄りすぎている。 | snapshot 対象の段階分割、変更候補の絞り込み、差分生成の incremental 化または fallback 条件の明確化を行う。snapshot stats を使った早期停止やキャッシュも検討する。 | 効果は大きいが影響範囲も広いため後半。先に session / audit / discovery 側の常時コストを減らしてから着手する。 |

## 推奨実装順序

1. **Session input responsiveness**
   - Session Window の入力遅延を直接下げる
2. **Session persistence summary/detail hydration**
   - 初期表示時の full row 読込と clone / hydration コストを下げる
3. **Session broadcast slimming**
   - payload fan-out と初期購読の過剰データ依存を解消する
4. **Workspace file search index**
   - `@path` 検索の scan 頻度を抑え、入力体感改善を補強する
5. **Audit log live persistence**
   - 実行中の読みやすさ、途中障害時の追跡性、完了時一括更新の偏りを改善する
6. **Skill/custom agent discovery cache**
   - picker 系の同期 I/O を削減する
7. **Memory management query optimization**
   - memory 件数増加時の UI 体感悪化を先回りで抑える
8. **Memory retrieval indexing**
   - turn 前処理の全件 scoring を candidate 絞り込み型へ寄せる
9. **Workspace snapshot / diff pipeline**
   - 効果は大きいが影響範囲も広いため、最後に独立 branch で取り組む

## 補足

- 各候補は、着手時に benchmark / manual check の観点を branch 内の plan へ追加する
- session 保存構造、IPC payload、memory index などの契約変更が入る task では、対応する design docs を同じ branch で更新する
- 今回は `Renderer state decomposition` を独立候補から外し、`Session input responsiveness`、`Session persistence summary/detail hydration`、`Memory management query optimization` などの局所 task に吸収した
- 本文書は implementation backlog ではなく、`次に branch を切る時の判断材料` として維持する
