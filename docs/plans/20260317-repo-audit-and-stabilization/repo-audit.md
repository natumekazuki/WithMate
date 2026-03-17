# Repo Audit

## 概要

- WithMate の現在の実装は、`CLI parity` と `stable roleplay injection` を優先した Electron デスクトップアプリとして成立している。特に `Home Window` / `Session Window` / `Character Editor Window` / `Diff Window` の 4 window 構成、Codex ベースの session 実行、audit log、diff、character CRUD、model catalog import/export、interrupted recovery は実装済みと判断できる。  
  根拠: `README.md`, `docs/design/product-direction.md`, `docs/design/window-architecture.md`, `docs/design/session-launch-ui.md`, `docs/design/desktop-ui.md`, `src-electron/main.ts`, `src/App.tsx`, `src/HomeApp.tsx`, `src/CharacterEditorApp.tsx`, `src/DiffApp.tsx`
- 一方で、WithMate 固有価値として掲げられている `parallel character stream` は、現行 milestone では pending 扱いのままであり、UI も実装も未接続である。  
  根拠: `README.md`, `docs/design/product-direction.md`, `docs/design/monologue-provider-policy.md`, `docs/manual-test-checklist.md`
- provider abstraction は設計されているが、現実装は `CodexAdapter` を中心に構成されており、`CopilotAdapter` 相当の実装は確認できなかった。  
  根拠: `docs/design/provider-adapter.md`, `src-electron/codex-adapter.ts`, `src-electron/main.ts`, `package.json`, `public/model-catalog.json`
- `Session Memory` / `Character Memory` / `LangGraph` を前提にした memory 設計は文書化されているが、現実装の永続化レイヤは session / audit log / app settings / model catalog / character storage までで止まっている。  
  根拠: `docs/design/memory-architecture.md`, `docs/design/session-persistence.md`, `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`, `src-electron/app-settings-storage.ts`, `src-electron/model-catalog-storage.ts`, `src-electron/character-storage.ts`, `package.json`

## 参照した根拠ファイル

### 要件・概要

- `README.md`
- `docs/要件定義_叩き.md`

### 設計

- `docs/design/product-direction.md`
- `docs/design/window-architecture.md`
- `docs/design/session-launch-ui.md`
- `docs/design/desktop-ui.md`
- `docs/design/provider-adapter.md`
- `docs/design/prompt-composition.md`
- `docs/design/audit-log.md`
- `docs/design/session-persistence.md`
- `docs/design/memory-architecture.md`
- `docs/design/monologue-provider-policy.md`
- `docs/design/character-storage.md`
- `docs/design/model-catalog.md`
- `docs/design/session-run-lifecycle.md`
- `docs/design/character-chat-ui.md`
- `docs/design/agent-event-ui.md`

### 実装・検証補助

- `docs/manual-test-checklist.md`
- `src/app-state.ts`
- `src/HomeApp.tsx`
- `src/App.tsx`
- `src/CharacterEditorApp.tsx`
- `src/DiffApp.tsx`
- `src/DiffViewer.tsx`
- `src/MessageRichText.tsx`
- `src/model-catalog.ts`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/composer-attachments.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/app-settings-storage.ts`
- `src-electron/model-catalog-storage.ts`
- `src-electron/character-storage.ts`
- `package.json`
- `public/model-catalog.json`

## 実装済み機能一覧

| 機能 | 内容 | 根拠ファイル |
| --- | --- | --- |
| 4 window の desktop 構成 | Home / Session / Character Editor / Diff を別 entry / 別 window として持つ | `README.md`, `docs/design/window-architecture.md`, `docs/design/desktop-ui.md`, `src-electron/main.ts`, `src/HomeApp.tsx`, `src/App.tsx`, `src/CharacterEditorApp.tsx`, `src/DiffApp.tsx` |
| Home での session 一覧・検索・resume 導線 | recent sessions、running / interrupted chip、検索、session open がある | `README.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/HomeApp.tsx`, `src-electron/main.ts`, `src-electron/session-storage.ts` |
| New Session 起動 | title / workspace / character を選んで session を作成し、Session Window を開ける | `README.md`, `docs/design/window-architecture.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/HomeApp.tsx`, `src-electron/main.ts`, `src/app-state.ts` |
| Character CRUD | character の作成・編集・削除、`character.md` と icon / meta の保存 | `README.md`, `docs/design/character-storage.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/CharacterEditorApp.tsx`, `src-electron/character-storage.ts`, `src-electron/main.ts` |
| Character theme color 管理 | `main / sub` color を保存し Home / launch / session card に反映する | `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/CharacterEditorApp.tsx`, `src/HomeApp.tsx`, `src/app-state.ts`, `src-electron/character-storage.ts`, `src-electron/session-storage.ts` |
| Prompt 合成 | `System Prompt Prefix` + `character.md` + user input を system / input / composed に分けて合成する | `docs/design/prompt-composition.md`, `docs/design/provider-adapter.md`, `src-electron/codex-adapter.ts`, `src-electron/main.ts`, `src-electron/app-settings-storage.ts` |
| Settings overlay | `System Prompt Prefix` の保存、model catalog import / export ができる | `README.md`, `docs/design/desktop-ui.md`, `docs/design/model-catalog.md`, `docs/manual-test-checklist.md`, `src/HomeApp.tsx`, `src-electron/main.ts`, `src-electron/app-settings-storage.ts`, `src-electron/model-catalog-storage.ts` |
| Model catalog の revision 管理 | SQLite 正本、bundled seed、import/export、session への revision 保存 | `docs/design/model-catalog.md`, `src/model-catalog.ts`, `src-electron/model-catalog-storage.ts`, `src-electron/session-storage.ts`, `src-electron/main.ts`, `public/model-catalog.json` |
| Session 実行 | Main Process 経由で `CodexAdapter.runSessionTurn()` を呼び出し、assistant message と artifact を保存する | `README.md`, `docs/design/provider-adapter.md`, `docs/design/session-run-lifecycle.md`, `src-electron/main.ts`, `src-electron/codex-adapter.ts`, `src/App.tsx` |
| Streaming 表示 | live assistant text / step / usage を Main Process から購読して Session UI に表示する | `docs/design/provider-adapter.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src-electron/main.ts`, `src-electron/codex-adapter.ts`, `src/App.tsx`, `src-electron/preload.ts` |
| 実行キャンセル | Session UI から `Cancel` し、AbortController で provider 実行を止める | `docs/design/session-run-lifecycle.md`, `docs/design/provider-adapter.md`, `docs/manual-test-checklist.md`, `src/App.tsx`, `src-electron/main.ts` |
| Approval / Model / Depth の session 単位反映 | session に保存し、model / depth 変更時は thread を切り替える | `README.md`, `docs/design/provider-adapter.md`, `docs/design/model-catalog.md`, `docs/design/session-persistence.md`, `docs/manual-test-checklist.md`, `src/App.tsx`, `src-electron/main.ts`, `src-electron/session-storage.ts` |
| `@path` 参照・picker・workspace 候補検索 | textarea から添付解決、workspace path suggestion、file / folder / image picker を持つ | `docs/design/prompt-composition.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/App.tsx`, `src-electron/composer-attachments.ts`, `src-electron/workspace-file-search.ts`, `src-electron/main.ts` |
| Artifact summary / Diff | changed files, operation timeline, run checks, inline diff, popout diff window を表示する | `README.md`, `docs/design/product-direction.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/App.tsx`, `src/DiffViewer.tsx`, `src/DiffApp.tsx`, `src-electron/codex-adapter.ts`, `src-electron/main.ts` |
| Audit log | 1 turn 1 record の `running / completed / canceled / failed` を SQLite に保存し、Session から閲覧できる | `docs/design/audit-log.md`, `docs/design/provider-adapter.md`, `docs/manual-test-checklist.md`, `src-electron/audit-log-storage.ts`, `src-electron/main.ts`, `src/App.tsx` |
| Session 永続化と interrupted recovery | session / thread / messages を保存し、再起動時に running を interrupted へ補正する | `README.md`, `docs/design/session-persistence.md`, `docs/design/session-run-lifecycle.md`, `docs/manual-test-checklist.md`, `src-electron/session-storage.ts`, `src-electron/main.ts`, `src/App.tsx` |
| 実行中 close / quit 保護 | Session close 確認、全 window close 時の Home 再生成、app quit 確認がある | `docs/design/window-architecture.md`, `docs/design/session-run-lifecycle.md`, `docs/manual-test-checklist.md`, `src-electron/main.ts` |
| Limited rich text 表示 | assistant message の markdown-like 表示と link / path open を行う | `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/MessageRichText.tsx`, `src/App.tsx`, `src-electron/main.ts` |

## 部分実装 / 制約付き実装一覧

| 機能 | 判定 | 内容 | 根拠ファイル |
| --- | --- | --- | --- |
| Provider abstraction | 部分実装 | 設計上は provider adapter 境界を持つが、実装は `CodexAdapter` のみ。`CopilotAdapter` は未確認 | `docs/design/provider-adapter.md`, `src-electron/codex-adapter.ts`, `src-electron/main.ts`, `package.json`, `public/model-catalog.json` |
| CLI parity | 制約付き実装 | workspace / session / approval / model / depth / diff / audit はあるが、requirements で期待される multi-provider や provider login / auth 面までは未実装 | `README.md`, `docs/要件定義_叩き.md`, `docs/design/product-direction.md`, `src/HomeApp.tsx`, `src/App.tsx`, `src-electron/main.ts` |
| Session launch flow | 制約付き実装 | 現 UI は `title / workspace / character` を入力して開始し、approval は `on-request` 固定、model / depth は default 初期化で一致している。一方で `session-launch-ui` が求める `provider の確認` は UI 上に露出しておらず、`window-architecture` には `provider を決める` とあるため、launch 文書間で provider 扱いが揺れている | `docs/design/window-architecture.md`, `docs/design/session-launch-ui.md`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`, `src/HomeApp.tsx`, `src-electron/main.ts`, `src/model-catalog.ts` |
| Session persistence | 部分実装 | session metadata / execution continuity / audit log / app settings はあるが、設計上の `Session Memory` は未接続 | `docs/design/session-persistence.md`, `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`, `src-electron/app-settings-storage.ts` |
| Memory architecture | 部分実装候補 | `Session Memory` / `Character Memory` / `Monologue Context` の設計はあるが、現 repo には永続化・更新・参照の実装は確認できない | `docs/design/memory-architecture.md`, `docs/design/session-persistence.md`, `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`, `src-electron/model-catalog-storage.ts`, `src-electron/character-storage.ts`, `package.json` |
| Character Stream 方針 | 制約付き実装 | 価値仮説と provider / memory 方針は設計されているが、現 UI では pending として露出を抑制している | `README.md`, `docs/design/product-direction.md`, `docs/design/monologue-provider-policy.md`, `docs/manual-test-checklist.md` |
| Agent event 可視化 | 制約付き実装 | operation timeline / changed files / live steps はあるが、設計文書にある approval request/resolution などの event 分類を網羅しているとは断定しにくい | `docs/design/agent-event-ui.md`, `src-electron/codex-adapter.ts`, `src/App.tsx` |

## 未実装機能一覧

| 機能 | 未実装と判断した理由 | 根拠ファイル |
| --- | --- | --- |
| Character Stream UI / monologue 実行 | 現行 README と desktop UI で pending 扱い。manual test にも含まれず、renderer / main に monologue 実装が見当たらない | `README.md`, `docs/design/product-direction.md`, `docs/design/monologue-provider-policy.md`, `docs/manual-test-checklist.md`, `src/App.tsx`, `src/HomeApp.tsx`, `src-electron/main.ts`, `src-electron/preload.ts` |
| Copilot provider 対応 | 要件書は Copilot 対応を掲げるが、依存・adapter・catalog が Codex 中心。`CopilotAdapter` 実装未確認 | `docs/要件定義_叩き.md`, `docs/design/provider-adapter.md`, `package.json`, `public/model-catalog.json`, `src-electron/codex-adapter.ts` |
| Session Memory 永続化 | 設計には明記されるが、実装 storage に該当レイヤがない | `docs/design/session-persistence.md`, `docs/design/memory-architecture.md`, `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`, `src-electron/model-catalog-storage.ts`, `src-electron/character-storage.ts` |
| Character Memory 永続化 | 設計には明記されるが、実装 storage に該当レイヤがない | `docs/design/memory-architecture.md`, `docs/design/session-persistence.md`, `src-electron/character-storage.ts`, `src-electron/session-storage.ts`, `src-electron/model-catalog-storage.ts`, `package.json` |
| LangGraph backend 統合 | memory 設計の前提だが、依存関係にも実装ファイルにも確認できない | `docs/design/memory-architecture.md`, `docs/design/session-persistence.md`, `package.json` |
| Monologue 用 API key / keychain 管理 | 要件書は API キーと OS keychain を示すが、現実装 settings は system prompt prefix と model catalog のみ | `docs/要件定義_叩き.md`, `docs/design/monologue-provider-policy.md`, `src/HomeApp.tsx`, `src-electron/app-settings-storage.ts` |
| Provider 認証状態の UI / 診断 | requirement / monologue policy から必要性は高いが、現行 UI / storage / preload API に該当導線がない | `docs/要件定義_叩き.md`, `docs/design/provider-adapter.md`, `docs/design/monologue-provider-policy.md`, `src/HomeApp.tsx`, `src-electron/preload.ts`, `src-electron/main.ts` |

## 設計から漏れていると推測される機能候補

> 本章は「未実装」ではなく、現行要件・設計・実装の並びから追加で設計を起こさないと後続実装が詰まりそうな論点を候補として整理したものです。断定ではありません。

| 候補 | 推測理由 | 根拠ファイル |
| --- | --- | --- |
| Provider 認証 / 接続状態の可視化 | Codex CLI login 前提、将来の OpenAI API key 前提、要件上の Copilot 対応が混在するが、どの画面で状態確認・エラー案内をするか設計が薄い | `docs/要件定義_叩き.md`, `docs/design/provider-adapter.md`, `docs/design/monologue-provider-policy.md`, `README.md` |
| Memory 更新失敗時の縮退動作と観測面 | memory 設計はあるが、Session Memory / Character Memory を後で実装する際の失敗時 UX・監査・再試行設計がまだ見えない | `docs/design/memory-architecture.md`, `docs/design/session-persistence.md`, `docs/design/audit-log.md` |
| 削除済み character を参照する既存 session の UX 完成形 | storage 設計では graceful degradation が別途扱いとなっており、現実装は最低限の再解決に留まる | `docs/design/character-storage.md`, `src-electron/main.ts`, `src-electron/session-storage.ts` |
| 監査ログの運用面 export / 共有要件 | 現状は UI 閲覧に限定されているが、repo audit や将来の不具合解析を考えると export 要件が後続で必要になる可能性がある | `docs/design/audit-log.md`, `docs/manual-test-checklist.md` |

## 要件 / 設計 / 実装のズレ

### 1. Provider 対応範囲のズレ

- 要件書では `Codex` と `GitHub Copilot` の両対応を掲げている。  
  根拠: `docs/要件定義_叩き.md`
- 設計では `provider-adapter` 文書が「Current MVP は `CodexAdapter` 1 実装」と整理している。  
  根拠: `docs/design/provider-adapter.md`
- 実装も `CodexAdapter` 中心で、依存関係・catalog・main process ハンドラも Codex 寄りである。  
  根拠: `src-electron/codex-adapter.ts`, `src-electron/main.ts`, `package.json`, `public/model-catalog.json`

**監査判断**: 要件に対して設計・実装が縮退している。現行実装の正確なスコープは「Codex 中心の desktop MVP」と明記した方が安全。

### 2. Character Stream の位置づけと pending 表示方針のズレ

- 要件書と一部初期設計は、`Character Stream` を Session UI の主要構成として描いている。  
  根拠: `docs/要件定義_叩き.md`, `docs/design/agent-event-ui.md`, `docs/design/character-chat-ui.md`
- その後の product direction / README / manual test では、現行 milestone では pending と整理されている。  
  根拠: `README.md`, `docs/design/product-direction.md`, `docs/design/monologue-provider-policy.md`, `docs/manual-test-checklist.md`
- `product-direction` と `monologue-provider-policy` は、current milestone では Session UI に Character Stream を出さず、API key 未設定時も pending 期間中も個別の縮退表示を持たない整理に寄っている。  
  根拠: `docs/design/product-direction.md`, `docs/design/monologue-provider-policy.md`
- 一方で `character-chat-ui` は「Issue #5 の current milestone では独り言 UI の本適用を止めて縮退表示を出す」「pending 期間中も縮退表示を出す」と記述し、`agent-event-ui` も右主面に `Character Stream` を維持する構成を残している。  
  根拠: `docs/design/character-chat-ui.md`, `docs/design/agent-event-ui.md`
- 実装は pending 側に揃っており、Session UI に Character Stream 面は無い。  
  根拠: `src/App.tsx`, `src/HomeApp.tsx`, `src-electron/main.ts`

**監査判断**: これは「設計から漏れている候補」ではなく、`設計文書の競合` と `要件 / 設計 / 実装のズレ` として扱う方が正確。現実装は `UI に出さない` 側に寄っている一方、設計文書には `縮退表示を残す` / `右面を維持する` 記述が残っている。

### 3. Session Memory / Character Memory のズレ

- 要件書は `関係性メモ` や session 再開を前提にしている。  
  根拠: `docs/要件定義_叩き.md`
- 設計は `Session Memory` / `Character Memory` / `Monologue Context` まで具体化している。  
  根拠: `docs/design/memory-architecture.md`, `docs/design/session-persistence.md`
- 実装 storage は session / audit / app settings / model catalog / character storage で止まっている。  
  根拠: `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`, `src-electron/app-settings-storage.ts`, `src-electron/model-catalog-storage.ts`, `src-electron/character-storage.ts`

**監査判断**: session persistence はあるが、memory persistence は未接続。設計の先行分が大きい。

### 4. Session launch 仕様のズレ

- `session-launch-ui` は New Session Launch の責務を `workspace 選択 / session title / character 確認 / provider 確認 / approval on-request 固定 / model・depth default 初期化 / Session Window で最初の prompt 入力` と整理している。  
  根拠: `docs/design/session-launch-ui.md`
- desktop UI と manual test は `title / workspace / character` を dialog で扱い、approval 非表示・`on-request` 固定、model / depth 非表示、Session Window 側で最初の prompt を送る現仕様に揃っている。  
  根拠: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- 実装も `HomeApp` で title / workspace / character を受け取り、`approvalMode: "on-request"` を埋めて session を作成し、作成後に Session Window を開く。provider picker は持たず、Main Process 側で active catalog の default provider / model / reasoning を補完している。  
  根拠: `src/HomeApp.tsx`, `src-electron/main.ts`, `src/model-catalog.ts`
- ただし `window-architecture` は依然として launch dialog で `provider` を「決める」と記述しており、`session-launch-ui` の `provider を確認する` よりも強い要求になっている。現実装は provider を確認も選択もできないため、不一致点は launch flow 全体ではなく `provider の露出方法` に絞られる。  
  根拠: `docs/design/window-architecture.md`, `docs/design/session-launch-ui.md`, `src/HomeApp.tsx`

**監査判断**: launch flow 全体は概ね `session-launch-ui` / `desktop-ui` / manual test / 実装で整合している。主要なズレは `provider を launch でどう扱うか` であり、`window-architecture` の旧記述と現実装の間に設計更新漏れが残っている可能性が高い。

### 5. セキュリティ / credential 管理のズレ

- 要件書では「API キーはローカル保存」「OS キーチェーン使用」としている。  
  根拠: `docs/要件定義_叩き.md`
- monologue provider policy でも API key 保存方針は open question。  
  根拠: `docs/design/monologue-provider-policy.md`
- 実装で確認できる app settings は `System Prompt Prefix` のみで、credential storage は未実装。  
  根拠: `src/HomeApp.tsx`, `src-electron/app-settings-storage.ts`, `src-electron/main.ts`

**監査判断**: 将来の provider 拡張前に、credential 管理は設計・実装ともに再整理が必要。

## 直近の仕様整理 backlog（まだ修正しない）

1. **Character Stream 関連文書の正本統一**
   - 理由: `UI に出さない` / `pending 中も縮退表示` / `右面構成を保持` が混在しており、これは未設計ではなく設計文書同士の競合として解消が必要。
   - 主な根拠: `docs/design/product-direction.md`, `docs/design/monologue-provider-policy.md`, `docs/design/character-chat-ui.md`, `docs/design/agent-event-ui.md`, `README.md`

2. **Provider 対応範囲の明文化と launch / settings 導線の整合化**
   - 理由: 要件は Copilot まで含むが、現実装は Codex 中心。現行 milestone の scope、launch 時の provider の見せ方、auth 導線を固定しないと監査観点でも誤解が残る。
   - 主な根拠: `docs/要件定義_叩き.md`, `docs/design/provider-adapter.md`, `docs/design/window-architecture.md`, `docs/design/session-launch-ui.md`, `src-electron/codex-adapter.ts`, `package.json`

3. **Memory 設計と現実装のギャップ解消方針の決定**
   - 理由: Session Memory / Character Memory が未実装のままだと、Character Stream 再開時だけでなく、要件上の「継続関係性」の到達点も曖昧なままになる。
   - 主な根拠: `docs/要件定義_叩き.md`, `docs/design/memory-architecture.md`, `docs/design/session-persistence.md`, `src-electron/session-storage.ts`, `src-electron/audit-log-storage.ts`, `src-electron/model-catalog-storage.ts`, `src-electron/character-storage.ts`

## 直近の bug fix / stabilization backlog（まだ修正しない）

| 優先 | 実バグ候補 | 対象導線 | 想定症状 | 根拠 |
| --- | --- | --- | --- | --- |
| 高 | 実行中でも approval を変更できる | Session Window の composer 下 `Approval` | manual test では「実行中に textarea / model / depth / approval は無効化されるべき」だが、現 UI では approval chip に `disabled` 相当の制御がなく、実行中に変更できる可能性が高い。Main Process 側の `updateSession` も実行中更新を拒否していないため、turn 中に session metadata が変わり、期待する操作制限と矛盾する | `docs/manual-test-checklist.md:96`, `src/App.tsx:1053-1067`, `src-electron/main.ts:349-350`, `src-electron/main.ts:968-980` |
| 高 | Session 内 markdown / path link が workspace 相対パスだと開けない可能性がある | assistant message の rich text link クリック | renderer は markdown link の target をそのまま `openPath` へ渡し、Main Process は URL 以外を `shell.openPath(trimmed)` へ直送している。workspace 相対パスは absolute path に解決されないため、assistant が `[src/App.tsx](src/App.tsx)` のように返した場合に開けず、UI 上は catch で握りつぶされる可能性がある | `src/MessageRichText.tsx`, `src/App.tsx:581-590`, `src-electron/main.ts:501-516` |
| 中 | workspace file search のキャッシュが陳腐化しうる | Session Window の `@path` 候補表示 | workspace file index は最初の scan 結果を Map に保持し、明示的な clear 呼び出しが見当たらない。session 実行や外部操作で file が追加・削除された後も、`@path` 候補が古いまま残る / 新規 file が出ない可能性がある | `src-electron/workspace-file-search.ts:12-28`, `src-electron/workspace-file-search.ts:62-69`, `src/App.tsx:289-317` |

## 補足

- 本監査は「現 repo に存在する文書と実装の照合」に基づく。実運用中 DB の中身や外部 provider 接続結果は今回の根拠に含めていない。
- 基線検証 `npm run typecheck`, `npm run build`, `npm run validate:snapshot-ignore` は、今回の作業着手前に pass 済みという前提情報を受領している。
