# Desktop UI

- 作成日: 2026-03-14
- 対象: Electron 版 WithMate の現在 UI

## Goal

Electron デスクトップアプリとして、`Home Window` / `Session Window` / `Character Editor Window` / `Diff Window` の責務を整理し、現行 UI の入口を 1 枚で把握できるようにする。

## Manual Test Maintenance

- 現行 UI に対する実機確認項目の正本は `docs/manual-test-checklist.md` とする
- この文書に影響する UI 変更を入れた場合は、同じ論理変更単位で実機テスト項目表も更新する
- 運用方針の詳細は `docs/design/manual-test-checklist.md` を参照する

## Scope

- Home の session / character 管理 UI
- Session Monitor Window
- Session の coding agent 作業 UI
- Character Editor の編集 UI
- Diff Window の閲覧 UI
- Settings Window と model catalog 操作
- Session の監査ログ閲覧 UI

## Runtime

- 対応 runtime は Electron のみ
- renderer は `window.withmate` を前提に動作する
- Vite dev server は Electron 開発時の配信面として使い、browser 単体での利用はサポートしない

## Home Window

- 黒基調の管理ハブとして表示する
- `Settings` は別 window で開く前提のため、Home は session / character 管理ハブを優先する
- 2 カラム構成
  - 左: `Recent Sessions`
  - 右: `Settings` rail + `Session Monitor` または `Characters`
- `Recent Sessions` / `Characters` 見出しは dark background 上で十分読める色を明示する
- `Monitor & Resume` / `Manage Cast` の補助ラベルは置かない
- `Session Monitor`
  - right pane 上部の segmented toggle で `Characters` と排他的に切り替える
  - 初期表示は `Session Monitor`
  - compact な session row を表示する
  - source は `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` を truth source にした open session ids と、`Recent Sessions` と同じ filtered session list の交差集合を使う
  - section
    - `実行中`: `running`
    - `停止・完了`: `interrupted` / `error` / `neutral` を含む non-running
  - row では `avatar / taskTitle / workspace / state badge` を表示し、クリックで session を開く
  - interrupted / error は non-running section でも badge で判別できる
  - open な SessionWindow がないときは、その旨が分かる empty state を出す
  - `Monitor Window` button から独立した monitor window を開ける
- `Recent Sessions`
  - section action として `New Session`
  - resume picker
  - session search input
    - `taskTitle / workspace`
    - 部分一致
  - card list は全 session を正本として表示し、storage 既定の `last_active_at DESC` を崩さない
  - card 常時表示情報
    - `avatar / taskTitle / runState badge / workspacePath / updatedAt`
    - `taskSummary` は 1 行補助情報として、空なら省略可
  - Home の state precedence
    - `status === "running"` または `runState === "running"` を最優先
    - 次に `runState === "interrupted"`
    - 次に `runState === "error"`
    - それ以外は neutral な non-active
    - 未知 state でも card は欠落させない
  - card theme
    - background = character `main`
    - left accent bar = character `sub`
    - text color = background とのコントラストから自動決定
- `Characters`
  - right pane 上部の segmented toggle で `Session Monitor` と排他的に切り替える
  - expanded 時だけ header action として `Add Character`
  - 選択中に search input + list を表示
  - `avatar / name`
  - card 全体クリックで `Character Editor` を開く
  - card theme
    - background = character `main`
    - left accent bar = character `sub`
    - text color = background とのコントラストから自動決定
- `New Session` dialog
  - session title 入力
  - workspace picker
  - enabled provider の選択
  - character 選択
  - approval mode は provider-neutral 3 mode を前提にし、default は `safety`
- `Settings` button
  - 独立した `Settings Window` を開く
- `Settings Window`
  - system prompt prefix 編集
  - `Coding Agent Providers` で provider 名と checkbox を 1 行 row で見せ、provider ごとの enable / disable を切り替える
  - `Coding Agent Credentials` で provider label を維持した `OpenAI API Key (Coding Agent)` 入力を表示
  - credential 補助文で `Character Stream 用ではない` ことを明示し、future note だけ最小限で置く
  - `Memory Extraction`
    - provider ごとの `Model`
    - provider ごとの `Reasoning Depth`
    - provider ごとの `Output Tokens Threshold`
    - `compact 前` / `session close 前` は強制実行
  - `Model Catalog` import / export
  - `Danger Zone` の `DB を初期化`
    - reset 対象を `sessions / audit logs / app settings / model catalog / project memory` から選べる
    - `sessions` を選ぶと `audit logs` も一緒に初期化される
    - 全対象選択時は DB ファイル再生成で schema も初期化する
    - reset 非対象: `characters`
    - confirm 後に実行する
  - 初回リリース前は後方互換性を考慮せず、非互換変更時はここから回復する
  - 縦が小さいときも overlay 内スクロールで末尾まで操作できる

## Session Monitor Window

- `Home` とは別の独立 window として開く
- 既定サイズは細く縦長の compact window とする
- `always on top` を初期 slice から有効にする
- renderer は `HomeApp` の compact monitor mode を再利用する
- 表示内容は Home 右ペインの `Session Monitor` と同じ truth source を使う
  - open な `Session Window` のみ表示する
  - `実行中` / `停止・完了` の 2 section を持つ
  - row では `avatar / taskTitle / workspace / state badge` を表示し、クリックで session を開く
- window 内の `Home` button から通常の `Home Window` を前面へ戻せる
- close は通常の window close と同じ扱いで、session 実行自体は止めない

## Session Window

- Home と同じ dark base を使う
- キャラカラーは限定的に使い、過度に Session 全体へ広げない
- session title の rename / delete
- `Audit Log` overlay
  - approval 表示は `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording を使う
- `Work Chat`
- 空 session では初期 assistant メッセージを置かない
- assistant / user message の markdown-like rich text 表示
- wide desktop (`1920x1080` baseline) では Session 本体を「`Top Bar + 中央 2 分割 + 下段 Action Dock`」にする
  - 上段: compact な `Top Bar`
  - 中央左: message list
  - 中央右: `Latest Command`
  - 下段: full-width の `Action Dock`
  - 左右の境界は draggable splitter で調整できる
  - narrow width では `message list -> Latest Command -> Action Dock` の縦 stack へ戻す
- `Top Bar`
  - default は compact
  - 常時表示するのは `title / Audit Log / Terminal / More / Close`
  - `Rename / Delete` は `More` で展開した時だけ表示する
  - `Terminal` は session の `workspacePath` を作業ディレクトリにした外部 terminal を開く
- `Action Dock`
  - compact / expanded の 2 状態を持つ
  - compact では draft preview 全体を reopen hit area にし、`Send / Cancel` だけを残す
  - retry banner、skill picker、`@path` 候補、blocked feedback がある時は expanded を維持する
- work surface は外側 card を持たず、padding / gap を抑えて message viewport を優先する
- message list は条件付き follow mode で動かす
  - viewport bottom gap が 80px 以下のときは末尾追従を許可する
  - 80px を超えて上へ読んでいる間は位置を維持する
  - `selectedSession.id` 切替時は follow / unread state をリセットする
  - 追従停止中は `新着あり` / `読み返し中` の最小 banner を表示し、`末尾へ移動` で復帰できる
- pending 中の live activity / streaming response
- pending bubble は会話本文の面として扱い、`assistantText` と run indicator を表示する
- `live run step` は pending bubble に混在させず、right pane の `Latest Command` へ要約して分離する
- right pane は `Latest Command / Memory生成 / 独り言` の tab host とする
- command 実行中は `Latest Command` を最優先で自動表示する
- background memory extraction 実行中は `Memory生成` へ自動切り替える
- `独り言` は current milestone では empty state host のみ置く
- right pane の empty / idle copy は説明過多にせず、使えば分かる最小表現を優先する
- `Latest Command` には raw command、status、source、rough risk badge、必要時だけ開く `details` を出す
- `Memory生成` には background activity の status、summary、必要時だけ開く `details` を出す
- provider が `Copilot` の時だけ、`Latest Command` の下に `Premium Requests` の薄い strip を常設し、残量だけを即読できるようにする
- `Context` は同じ領域の collapsed details として置き、ユーザーが開くまでは右 pane の面積をほとんど使わない
- `assistantText` は pending bubble の会話本文としてのみ扱い、`agent_message` を activity row へ戻さない
- pending bubble の実行中 indicator は本文の代替ではなく `runState === "running"` を示すフラグとして扱い、`assistantText` の出力開始後も run 中は維持する
- pending bubble の実行中 indicator は `runState !== "running"` になった時点で消し、success 固定の完了表現にはしない
- pending bubble の実行中 indicator copy は character ごとに `session copy` で差し替えられる
- default fallback は bland な一般化表現を使い、character copy が未設定でも過剰にキャラ化しない
- `assistantText` 未着でも right pane の `Latest Command` があれば raw command を表示し、command 未到着の局面では empty state と pending bubble の run indicator で待機を示す
- `Latest Command` の waiting / empty copy、retry banner title、`Changed Files` empty copy も character ごとに差し替えられる
- pending bubble の実行中 indicator は本文と同居できる先頭 status row とし、screen reader には bubble 全体ではなく状態変化だけを最小限に通知して再アナウンス過多を避ける
- `command_execution` は通常 paragraph ではなく shell command と即判別できる専用の monospace block で表示する
- `details` は stdout / stderr など二次情報だけを折りたたみ表示する
- `liveRun.errorMessage` は `Latest Command` card 内の alert block として扱う
- right pane は run 中の command 安全確認面として扱い、full timeline や `Turn Inspector` は常設しない
- 実行中は `Send` の代わりに `Cancel` を表示
- assistant message ごとの `Turn Summary`
  - `Changed Files`
  - `Run Checks`
    - approval は `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording で表示する
  - turn 内の `agent_message / command_execution / file_change / reasoning` を arrival 順に並べる operation timeline
- composer 上の添付 toolbar (`File / Folder / Image`)
- `File / Folder / Image` は attachment group として並べ、`Skill` は別カテゴリの単独 button として区別する
- composer の attachment chip
  - basename を主表示にし、file / folder / image の kind と `ワークスペース内` / `ワークスペース外` を即判別できる
  - 補足 path は副次表示へ回し、long path でも basename を先に読める
- textarea 内の `@path` 参照
- `@path` 入力中の workspace file path 候補表示
  - 候補表示条件は `@` 後 query 非空のまま維持する
  - row は basename 優先 + 親 path 補足で表示する
  - 候補 open 中だけ `ArrowUp` / `ArrowDown` / `Enter` / `Tab` / `Escape` の keyboard navigation を有効にする
- picker で選んだ file / folder / image も textarea に `@path` を挿入する
- 添付 picker は初回だけ workspace を開き、以後は最後に選んだディレクトリを開く
- composer toolbar に `Add Directory` を置き、その横の toggle から `Additional Directories` 一覧を既定 closed で開閉できるようにする
- composer 下の `Approval / Model / Depth`
  - approval chip は `自動実行 / 安全寄り / プロバイダー判断`
- session title は character `main`
- assistant / pending bubble は `sub` ベースの薄い accent を持つ
- `composer settings` の背景は `sub` ベースの薄い accent を持つ
- `Send / Cancel` は character `main`
- sendability 判定は `src/App.tsx` の単一導出に寄せ、`sessionExecutionBlockedReason` / `composerPreview.errors` を Send 近傍の単一 feedback area で扱う
- 実行中の latest command 監視の詳細は `docs/design/session-live-activity-monitor.md` を参照する
- wide desktop の再配置詳細は `docs/design/session-window-layout-redesign.md` を参照する
- chrome 削減の現仕様は `docs/design/session-window-chrome-reduction.md` を参照する
- Send disabled 条件は submit button / `Ctrl+Enter` / `Cmd+Enter` guard で一致させ、blank / whitespace-only draft の no-op 送信を通さない
- `runState === "running"` では `Cancel` 主体の既存 UX を維持し、送信不可説明を主表示しない
- `Details` 展開後の artifact block 背景は `main / sub` の薄い accent を持つ
- `Ctrl+Enter` / `Cmd+Enter` 送信
- `interrupted` 時の再送導線
  - `runState === "running"` 中は retry banner を出さず、既存 pending / `Cancel` を維持する
  - `runState === "interrupted"` + `lastUserMessage` ありで interruption banner を出し、failed copy に寄せない
  - `runState === "error"` + `lastUserMessage` ありで failed banner を出す
  - `runState === "idle"` でも最新 terminal Audit Log `phase === "canceled"` + `lastUserMessage` ありなら canceled banner を出す
  - `lastUserMessage` がない session では retry 不能のため banner を出さない
  - 状態識別は badge / title / CTA を主役にし、状態別 body 段落は置かない
  - retry banner 共通で `Details` / `Hide` toggle を持たせ、badge / title / CTA / draft conflict notice は常時表示に残す
  - details の default は `canceled` が collapsed、failed / `interrupted` が expanded
  - 折りたたみ対象は `停止地点` / `前回の依頼` と、その短い summary / fallback を中心にする
  - details 開閉 state は renderer local state で持ち、session 切替または retry banner identity（kind / `lastUserMessage` / canceled 判定に使う terminal Audit Log entry）変化時だけ default へ reset する
  - 同一 retry banner 上の draft 編集や軽微な再描画では details 開閉 state を保持する
  - retry CTA は `同じ依頼を再送` と `編集して再送`
    - `同じ依頼を再送`: 既存 resend 経路で即時再送し、draft は書き換えない
    - `編集して再送`: `lastUserMessage.text` を draft へ戻して textarea へ focus し、自動送信しない
  - 停止地点サマリは live step / artifact / Audit Log operations から 1 行だけ拾い、取れないときは `停止地点は復元できませんでした。` / `エラー箇所は復元できませんでした。` / `停止位置は記録されていません。` の短い fallback を使う
  - draft が非空のまま `編集して再送` を押したときは silent overwrite をせず、composer 内で `今の下書きは残しています。` と短く示したうえで明示的な置換導線を出す
- inline `Diff Viewer` overlay
- `Open In Window` による `Diff Window` popout

## Character Editor Window

- `Profile / character.md` の 2 モード切り替え
- Home と同じ dark base を使う
- 画面下部固定の action bar に `Save / Delete`
- `Name`
- `Icon`
- `Description`
- `Theme Colors`
  - `main`
  - `sub`
  - color picker + RGB 入力
- `character.md`
- create / update / delete
- 小さい window では縦積みと外側スクロールを優先し、内部スクロールの多重化を避ける

## Diff Window

- side-by-side split diff
- 縦スクロール同期
- 横スクロール同期
- 長い行は横スクロールで読む
- Session から開いた Diff は character theme snapshot を引き継ぎ、`titlebar / subbar / pane header` にだけ薄い accent を持つ
- `Before / After` 見出しは差分面から独立した label chip として表示し、背景色に埋もれないコントラストを維持する

## Interaction Notes

- Home から Session / Character Editor を開く
- Session の作成・更新・削除は Main Process 経由で永続化する
- Session の実行中イベントは Main Process から live state として IPC 中継する
- Home の `Session Monitor` は Main Process の `sessionWindows` を thin IPC bridge で参照し、開いている `Session Window` の session だけを表示する
- `Session Monitor Window` も同じ IPC bridge と truth source を使い、`Home` と別 window でも monitor 内容を同期する
- Session 実行の監査ログは SQLite に保存し、Session Window から閲覧する
- chat message は限定的な rich text renderer で整形表示する
- `Settings Window` の `System Prompt Prefix` は SQLite に保存し、次回 turn から prompt composition へ反映する
- `Settings Window` の `DB を初期化` 成功時は各 window が reset 後 `appSettings` / `modelCatalog` / `sessions` へ同期し、settings draft の dirty を解消する
- character は `userData/characters/` を正本とする
- `userData` は `<appData>/WithMate/` に固定する
- Session は character の `main / sub` theme color snapshot を保持し、現在は header title、assistant / pending bubble、composer settings、`Send / Cancel`、artifact block、Session から開く Diff の `titlebar / subbar / pane header` の限定的な accent に使う
- session は SQLite を正本とする
- model catalog は DB の active revision を読む
- message list follow mode は assistantText streaming / pending bubble 更新に反応し、command 監視は right pane の `Latest Command` へ分離する

## Deliverables

- `src/HomeApp.tsx`
- `src/withmate-window.ts`
- `src/App.tsx`
- `src/MessageRichText.tsx`
- `src/CharacterEditorApp.tsx`
- `src/DiffApp.tsx`
- `src/DiffViewer.tsx`
- `src/app-state.ts`
- `src/ui-utils.tsx`
- `docs/design/message-rich-text.md`
- `src-electron/main.ts`
- `src-electron/preload.ts`
- `src-electron/composer-attachments.ts`
- `src-electron/session-storage.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/app-settings-storage.ts`
- `src-electron/character-storage.ts`
- `src-electron/model-catalog-storage.ts`
- `docs/manual-test-checklist.md`

## Runbook

```bash
npm install
npm run dev
# 別ターミナル
npm run electron:dev
```

ビルド済み確認:

```bash
npm run build
npm run electron:start
```
