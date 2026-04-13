# 最適化ロードマップ

- 作成日: 2026-04-13
- 対象: WithMate の最適化候補整理

## 目的

WithMate の frontend / backend を通して、現状の処理コストが高い箇所を `1機能 = 1ブランチ` で実装できる粒度に分解する。  
この文書は、次の最適化 task を切る時に、候補名・branch 名・対象ファイル・方針・着手順をすぐ参照できる入口として使う。

## ブランチ命名ルール（提案）

- 形式: `opt/<領域>-<機能名>`
- 例:
  - `opt/session-persistence-summary-projection`
  - `opt/session-broadcast-slimming`
  - `opt/workspace-file-search-index`
- ルール:
  - 1 branch で 1 候補だけを扱う
  - `<領域>` は `session` `renderer` `workspace` `memory` `discovery` など broad な責務名に寄せる
  - `<機能名>` は docs 上の候補名と対応が分かる kebab-case にそろえる
  - 実装中に別の大きな構造問題が見つかった場合は branch を増やして follow-up 化する

## 優先度の考え方

優先度は次の順で判断する。

1. **常時コストか**
   - session 一覧取得、broadcast、renderer 再計算のように、普段の操作で毎回走る処理を先に触る
2. **payload / clone の削減幅が大きいか**
   - 全件 clone、巨大 JSON、全 window broadcast のように fan-out が大きいものを優先する
3. **局所改善で効果が出るか**
   - index / cache / summary projection のように、既存責務を崩さず段階導入できるものを先に進める
4. **依存関係が少ないか**
   - renderer 分解や snapshot pipeline のような広い変更は、先に軽量なボトルネックを減らした後に着手する
5. **計測しやすいか**
   - before / after を session 数、検索件数、memory 件数、snapshot size で比較しやすい候補を優先する

## 最適化候補一覧

| 機能名 | 推奨ブランチ名 | 対象領域 | 主対象ファイル | 現状の非効率ポイント | 最適化方針 | 依存 / 着手順メモ |
| --- | --- | --- | --- | --- | --- | --- |
| Session persistence summary projection | `opt/session-persistence-summary-projection` | Electron main / persistence / IPC query | `src-electron/session-storage.ts`<br>`src/session-state.ts`<br>`src-electron/main-query-service.ts` | `messages_json` / `stream_json` を含む full session を毎回 parse・clone し、`cloneSessions()` が JSON stringify/parse で全件 deep copy している。`listSessions()` と `getSession()` の query でも summary 用と詳細用の境界がない。 | session 一覧向けの summary projection を導入し、詳細取得時だけ `messages` / `stream` を復元する。clone を summary / detail 単位で見直し、IPC query も一覧用 payload を slim 化する。 | 最優先。後続の broadcast slimming と renderer state 分解の前提になる。DB schema 追加が必要なら `docs/design/database-schema.md` も同 task で更新する。 |
| Session broadcast slimming | `opt/session-broadcast-slimming` | Electron main / IPC broadcast | `src-electron/window-broadcast-service.ts`<br>`src-electron/main-broadcast-facade.ts` | session 変更時に full payload を全 window へ broadcast しており、Home / Session / monitor 間で不要な再送と再描画が起きやすい。 | session summary broadcast、差分 broadcast、window 種別ごとの配信内容整理を行う。必要なら `session updated / removed / reordered` のイベント粒度へ分解する。 | `Session persistence summary projection` 後が着手しやすい。payload 契約変更のため renderer 側確認が必要。 |
| Renderer state decomposition | `opt/renderer-state-decomposition` | React renderer / UI state | `src/HomeApp.tsx`<br>`src/App.tsx` | `HomeApp` と `App` に巨大 state と多数の projection / subscription が集約され、1 更新で広い再計算と再 render が起きやすい。 | session summary / detail、telemetry、picker、settings、memory view などを責務別 hook / selector に分割し、購読単位と projection を局所化する。 | broadcast / query slimming の後に着手すると効果が見えやすい。UI regression を避けるため branch を細かく分割しない。 |
| Workspace snapshot / diff pipeline | `opt/workspace-snapshot-diff-pipeline` | Provider runtime / file scan / diff | `src-electron/codex-adapter.ts`<br>`src-electron/snapshot-ignore.ts` | turn 実行時の workspace snapshot capture が全走査ベースで重く、diff 生成も large file / large matrix でコストが高い。 snapshot と diff の責務が 1 pipeline に寄りすぎている。 | snapshot 対象の段階分割、変更候補の絞り込み、差分生成の incremental 化または fallback 条件の明確化を行う。 snapshot stats を使った早期停止やキャッシュも検討する。 | 影響が広く回帰リスクも高いので後半。先に session / renderer 側の常時コストを減らしてから着手する。 |
| Workspace file search index | `opt/workspace-file-search-index` | Electron main / workspace search | `src-electron/workspace-file-search.ts` | file index TTL が 5 秒固定で、検索間隔によっては scan が頻発する。毎回 `scanWorkspacePaths()` 由来の全走査コストを背負いやすい。 | TTL の見直し、workspace mtime / invalidate 契機ベースの cache、prefix index や検索結果 cache を導入し、scan 回数を減らす。 | 単独で切り出しやすい低リスク候補。snapshot pipeline より先に着手してよい。 |
| Memory management query optimization | `opt/memory-management-query-optimization` | React renderer / memory UI | `src/memory-management-view.ts`<br>`src/HomeApp.tsx` | search / domain / category / sort のたびに全件 filter / sort を繰り返し、group ごとの再構成も毎回走る。delete / reload のたびに full snapshot を再取得しており、件数増加で UI が重くなりやすい。 | 正規化済み検索キー、domain 別 selector、事前 sort 済み index、必要なら list virtualization を導入する。filter 条件が変わらない時の再利用に加え、full snapshot 再取得を避ける query / mutation 粒度への見直しも行う。 | renderer state decomposition と近いが、branch は分ける。memory 件数が増えた時の体感差が出やすい。 |
| Skill/custom agent discovery cache | `opt/discovery-cache` | Electron main / filesystem discovery | `src-electron/skill-discovery.ts`<br>`src-electron/custom-agent-discovery.ts` | discovery が同期 I/O ベースで、session 切り替えや picker 表示ごとに `existsSync` `readdirSync` `readFileSync` を繰り返す。 | workspace 単位の discovery cache、mtime ベース invalidation、非同期 I/O 化を行う。workspace / provider / global source のマージ結果もキャッシュする。 | `Workspace file search index` と同系統の cache 方針で進めるとよい。比較的独立して着手できる。 |
| Memory retrieval indexing | `opt/memory-retrieval-indexing` | Electron main / memory retrieval | `src-electron/project-memory-retrieval.ts`<br>`src-electron/character-memory-retrieval.ts` | retrieval のたびに全 entry を token 化・scoring・sort しており、memory 件数増加で turn 前処理コストが増える。 | entry 側の前処理済み token / fingerprint index を持ち、query 時は candidate 絞り込み後に scoring する。 category / updatedAt / keyword の補助 index も検討する。 | `Memory management query optimization` とは別 task。件数が少ない段階では効果が見えにくいので、計測メモを残して進める。 |

## 推奨実装順序

1. **Session persistence summary projection**
   - 全画面に効く clone / parse / query コストの削減
2. **Session broadcast slimming**
   - IPC fan-out と renderer 再描画を抑える
3. **Renderer state decomposition**
   - slim 化した payload を前提に購読と projection を分割する
4. **Workspace file search index**
   - 低リスクで scan 頻度を減らしやすい
5. **Skill/custom agent discovery cache**
   - picker 系の同期 I/O を削減する
6. **Memory management query optimization**
   - memory 件数増加時の UI 体感悪化を先回りで抑える
7. **Memory retrieval indexing**
   - turn 前処理の全件 scoring を candidate 絞り込み型へ寄せる
8. **Workspace snapshot / diff pipeline**
   - 効果は大きいが影響範囲も広いため、最後に独立 branch で取り組む

## 補足

- 各候補は、着手時に benchmark / manual check の観点を branch 内の plan へ追加する
- session 保存構造、IPC payload、memory index などの契約変更が入る task では、対応する design docs を同じ branch で更新する
- 本文書は implementation backlog ではなく、`次に branch を切る時の判断材料` として維持する
