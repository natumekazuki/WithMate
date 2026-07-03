# Desktop UI

- 作成日: 2026-03-14
- 対象: Electron 版 WithMate の現在 UI

## Goal

Electron デスクトップアプリとして、`Home Window` / `Character Editor Window` / `Session Window` / `Diff Window` / `Settings Window` / `Session Monitor Window` の責務を整理し、現行 UI の入口を 1 枚で把握できるようにする。V5 preview では legacy MateTalk runtime / `mate-talk` mode を current UI として扱わない。

## Manual Test Maintenance

- 現行 UI に対する実機確認項目の正本は `docs/manual-test-checklist.md` とする
- この文書に影響する UI 変更を入れた場合は、同じ論理変更単位で実機テスト項目表も更新する
- 運用方針の詳細は `docs/design/manual-test-checklist.md` を参照する

## Scope

- Home の session / Character catalog 管理 UI
- Character Editor Window
- Session Monitor Window
- Session の coding agent 作業 UI
- Diff Window の閲覧 UI
- Settings Window と model catalog 操作
- Session の監査ログ閲覧 UI

## UI Source Of Truth Boundary

- current UI の正本はこの文書とする
- UI の経緯メモや旧検討文書は `docs/design/archive/2026/03/` へ移しており、この文書より優先しない

## UI Implementation Boundary

- 画面の実装ファイルは、表示される入口ではなく役割ごとの domain に置く
- `Home` 配下に置くのは Home dashboard と Home から直接見える管理ハブだけとする
- `Settings Window` の画面実装は `settings` domain に置き、Home の実装ファイルへ混ぜない
- Character catalog は `character` / `character-editor` domain を正本にし、Home には一覧と editor window 起動だけを置く
- chat layout の実装は 1 系統だけとし、`chat` domain を正本にする
- Agent / Companion は同じ chat layout に乗せ、各機能側には state / service / adapter だけを置く
- `Session` という名前の UI 実装に Agent / Companion 固有処理を詰め込まない。必要な差分は mode / capability / adapter として注入する
- right pane に表示する情報がない mode では、説明文や誘導文で埋めず、空の pane shell として扱う

## Runtime

- 対応 runtime は Electron のみ
- renderer は `window.withmate` を前提に動作する
- Vite dev server は Electron 開発時の配信面として使い、browser 単体での利用はサポートしない
- 各 renderer entry point は window-level error boundary を持ち、描画クラッシュ時も `再試行` / `再読み込み` で復帰を試せるようにする

## Home Window

- 黒基調の管理ハブとして表示する
- `Settings` は別 window で開く前提のため、Home は session / Character catalog 管理ハブを優先する
- 2 カラム構成
  - 左: `Recent Sessions`
  - 右: `Memory / Settings` rail + `Session Monitor` または `Characters`
- `Recent Sessions` / `Characters` 見出しは dark background 上で十分読める色を明示する
- `Monitor & Resume` / `Manage Cast` の補助ラベルは置かない
- `Session Monitor`
  - right pane 上部の segmented toggle で `Characters` と排他的に切り替える
  - 初期表示は `Session Monitor`
  - compact な session row を表示する
  - source は `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` を truth source にした open session ids と、`Recent Sessions` と同じ filtered session list の交差集合を使う
  - `sessionKind === "character-update"` の update 専用 session は monitor 対象から除外する
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
    - `taskTitle / workspace / kind label`
    - 部分一致
  - card list は全 session を正本として表示し、storage 既定の `last_active_at DESC` を崩さない
  - `sessionKind === "character-update"` の update 専用 session はこの一覧から除外する
  - `sessionKind === "character-authoring"` の Character authoring session は通常 session と同じ削除・再開導線へ到達できるよう表示する
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
    - background = mate `main`
    - left accent bar = mate `sub`
    - text color = WCAG AA の contrast ratio を満たす dark / light 候補から自動決定
- `Characters`
  - right pane 上部の segmented toggle で `Session Monitor` と排他的に切り替える
  - Character catalog の active Character を card list で表示する
  - header に `Create Character` を置く
  - card には avatar / name / description / default badge / updatedAt / `Edit` を表示する
  - card click または `Edit` で `Character Editor Window` を開く
  - Character 0 件時は empty state と `Create Character` を表示する
  - Home には archive / delete / Set Default を置かない
  - `Your Mate` / MateTalk launcher / Mate Profile 編集導線は表示しない
  - card theme
    - background = Character `main`
    - left accent bar = Character `sub`
    - text color = WCAG AA の contrast ratio を満たす dark / light 候補から自動決定
- `New Session` dialog
  - session title 入力
  - workspace picker
  - enabled provider の選択
  - Character selector で default Character を初期選択する。Character が 0 件の場合は neutral fallback を使う
  - approval mode は provider-neutral 3 mode を前提にし、default は `safety`
  - model / depth / custom agent は dialog には出さず、選択中 provider の直近 session があればその selection を継承する
  - open 時は dialog 内の最初の主要入力へ focus し、`Escape` で閉じる
  - `Tab` / `Shift+Tab` で dialog 外へ focus を逃がさない
  - provider の single-select chip は矢印キーで選択を移動できる
- `Settings` button
  - 独立した `Settings Window` を開く
- `Settings Window`
  - dedicated window shell を使い、window 幅いっぱいまで panel が追従する
  - header copy や `Home / Close` は置かず、内容本体と保存 footer に分ける
  - 本文は inner scroll で流し、shell の角丸と scrollbar が干渉しないようにする
  - `Session Window`
    - `送信後に Action Dock を自動で閉じる`
  - `Default Microcopy`
  - `Coding Agent Providers` で provider 名と checkbox を 1 行 row で見せ、provider ごとの enable / disable を切り替える
  - `Diagnostics`
  - `Model Catalog` import / export
  - 縦が小さいときも overlay 内スクロールで末尾まで操作できる

## Character Editor Window

- Home の `Characters` panel から create / edit mode で開く
- 1 Character に集中して編集する独立 window とする
- header
  - avatar / name / description
  - create / edit / archived の mode
  - saved / unsaved / saving の状態
- tabs
  - `Profile`
  - `character.md`
  - `character-notes.md`
  - `Preview`
- `Profile`
  - name
  - description
  - icon path + Browse
  - theme main / sub
  - default state と `Set Default`
- `character.md`
  - runtime definition の正本である説明
  - save 前 validation summary
  - raw markdown editor
  - import / replace
- `character-notes.md`
  - authoring notes / evidence / revision notes 用である説明
  - V5 Core では runtime prompt に常設注入しない境界説明
  - raw markdown editor
- `Preview`
  - Home card preview
  - launch selector row preview
  - runtime snapshot boundary の説明
- footer
  - destructive な `Archive` は左へ離して置き、confirm を挟む
  - `Reload` / `Cancel` / `Save`
- close
  - dirty draft では discard confirm を出す
- Character 定義自動生成、LLM 添削、section editor、revision / rollback、Character Update Workspace は current UI に含めない

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
- チャット UI の実装正本は `chat` domain の単一 UI 定義だけとする
- Agent / Companion / メイトークは同じ chat screen / header / message list / composer / right pane shell を使い、mode と service adapter で差分を切り替える
- 新しい会話機能を追加する場合も、chat layout 実装を増やさず、Session UI の mode を追加する
- `sessionKind === "character-update"` の時は update 用 mode に切り替える
- session title の rename / delete
- `Audit Log` overlay
  - approval 表示は `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording を使う
- `Work Chat`
- 空 session では初期 assistant メッセージを置かない
- assistant / user message の markdown-like rich text 表示
- wide desktop (`1920x1080` baseline) では Session 本体を「`header(必要時のみ) + 中央 2 分割`」にする
  - 通常時は左列を最上端から `message list + Action Dock` に使い切る
  - 右列は `title handle + context pane` を持つ
  - title handle を押した時だけ、header が左端まで伸びた full-width strip として出る
  - 中央左: `message list + Action Dock`
  - 中央右: `Latest Command`
  - 左右の境界は draggable splitter で調整できる
  - right pane は Action Dock の手前で切らず、下端まで縦に伸ばす
  - narrow width では `message list + Action Dock -> Latest Command` の縦 stack へ戻す
  - current minimum は split-screen を考慮し、`900px` 台の window 幅でも縦 stack のまま到達性を維持する
  - Full HD では文字サイズそのものより density を先に調整し、Session 専用の gap / padding / chip / button 高さをやや詰める
  - user bubble は assistant avatar 分の左 gutter を持たず、row 幅いっぱいを使えるようにする
- `Top Bar`
  - default は right pane 上部の `title handle` だけを見せる
  - title handle を押すと full-width header に切り替わり、`Rename / Audit Log / Terminal / Delete` を常時表示する
  - `More` と `Close` は使わない
  - title をもう一度押すと collapsed state へ戻れる
- `Action Dock`
  - compact / expanded の 2 状態を持つ
  - wide では message list と同じ左列幅に揃える
  - compact では draft preview 全体を reopen hit area にし、`Send / Cancel` だけを残す
  - default では通常送信の直後に compact へ戻す
  - この auto close は Settings の checkbox で ON / OFF を切り替えられ、初期値は ON とする
  - retry banner、skill picker、`@path` 候補、blocked feedback がある時は expanded を維持する
- work surface は外側 card を持たず、padding / gap を抑えて message viewport を優先する
- message list は条件付き follow mode で動かす
  - viewport bottom gap が 80px 以下のときは末尾追従を許可する
  - 80px を超えて上へ読んでいる間は位置を維持する
  - `selectedSession.id` 切替時は follow / unread state をリセットする
  - 追従停止中は `新着あり` / `読み返し中` の最小 banner を表示し、`末尾へ移動` で復帰できる
- pending 中の live activity / streaming response
- pending bubble は会話本文の面として扱い、`assistantText` と run indicator を表示する
- pending bubble には provider-native pending item を差し込める
  - `approvalRequest`: `今回だけ許可 / 拒否`
  - `elicitationRequest`: form または URL completion の `送信 / 拒否 / 閉じる`
- `live run step` は pending bubble に混在させず、right pane の `Latest Command` へ要約して分離する
- right pane は `Latest Command` を基本 tab とし、provider が `Copilot` の時だけ `Tasks` tab を追加する
- right pane 上部には collapsed state の `title handle` を置く
- right pane shell は Agent / Companion で共有する。表示する内容がない mode では pane 構造だけを残し、説明文や空メッセージを常設しない
- `Generate Memory` は current UI では表示しない
- `character-update` mode では right pane を `LatestCommand / MemoryExtract` の 2 面に切り替える
- `character-update` mode では expanded header の `Terminal` を出さない
- `character-update` mode では composer の `Skill / Agent` picker を出さない
- command 実行中は `Latest Command` を最優先で自動表示する
- MemoryGeneration / 独り言の right pane 自動切り替えは行わない
- right pane の empty / idle copy は説明過多にせず、使えば分かる最小表現を優先する
- `Latest Command` には raw command、status、source、rough risk badge、必要時だけ開く `details` を出す
- 実行中に確定した live step があれば、`Latest Command` の下に `CONFIRMED Details` として直近数件だけ補助表示してよい
  - 直近の in-progress command とは分ける
  - full timeline には戻さず、summary + optional `details` に留める
- provider が `Copilot` で background task snapshot が来た時は、right pane の `Tasks` tab で `agent / shell` の running / completed / failed を確認できるようにする
- `Tasks` tab は `/tasks` 全機能の再現ではなく、current session に紐づく background task の coarse な観測面に留める
- `Memory生成` tab は current UI では表示しない
- provider が `Copilot` の時だけ、`Latest Command` の下に `Premium Requests` の薄い strip を常設し、残量だけを即読できるようにする
- `Context` は同じ領域の collapsed details として置き、ユーザーが開くまでは右 pane の面積をほとんど使わない
- `assistantText` は pending bubble の会話本文としてのみ扱い、`agent_message` を activity row へ戻さない
- pending bubble の実行中 indicator は本文の代替ではなく `runState === "running"` を示すフラグとして扱い、`assistantText` の出力開始後も run 中は維持する
- pending bubble の実行中 indicator は `runState !== "running"` になった時点で消し、success 固定の完了表現にはしない
- pending bubble の実行中 indicator copy は Mate ごとに `session copy` で差し替えられる
- default fallback は bland な一般化表現を使い、Mate copy が未設定でも過剰にキャラ化しない
- `assistantText` 未着でも right pane の `Latest Command` があれば raw command を表示し、command 未到着の局面では empty state と pending bubble の run indicator で待機を示す
- `Latest Command` の waiting / empty copy、retry banner title、`Changed Files` empty copy も Mate ごとに差し替えられる
- pending bubble の実行中 indicator は本文と同居できる先頭 status row とし、screen reader には bubble 全体ではなく状態変化だけを最小限に通知して再アナウンス過多を避ける
- explicit な `aria-live` は pending bubble の status change に寄せ、retry draft conflict、message follow banner、composer feedback は visible text を正本にして常時 live 通知しない
- `command_execution` は通常 paragraph ではなく shell command と即判別できる専用の monospace block で表示する
- `details` は stdout / stderr など二次情報だけを折りたたみ表示する
- `liveRun.errorMessage` は `Latest Command` card 内の alert block として扱う
- right pane 自体の描画失敗は pane 専用 fallback に切り替え、`右ペインを再描画` と `Window を再読み込み` を出す
- right pane は run 中の command 安全確認面として扱い、full timeline や `Turn Inspector` は常設しない
- 実行中は `Send` の代わりに `Cancel` を表示
- assistant message ごとの `Turn Summary`
  - 展開導線は chat row の独立 1 行 button ではなく、assistant bubble 右上の小さい icon button とする
  - `Changed Files` は 1 ブロックでまとめて default closed とし、file list は開いた時だけ見せる
  - `Run Checks`
    - approval は `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording で表示する
  - turn 内の `agent_message / command_execution / file_change / reasoning` を arrival 順に並べる operation timeline は item ごとに default closed とし、summary 1 行だけを先に見せる
- composer 上の添付 toolbar (`File / Folder / Image`)
- `File / Folder / Image` は attachment group として並べ、`Skill` は別カテゴリの単独 button として区別する
- 添付 toolbar は Agent / Companion の作業 chat 用であり、メイトークでは表示しない
- composer の attachment chip
  - basename を主表示にし、file / folder / image の kind と `ワークスペース内` / `ワークスペース外` を即判別できる
  - 補足 path は副次表示へ回し、long path でも basename を先に読める
  - attachment list は高さ上限つき scroll にし、多数添付時も textarea と `Send` を押し流さない
- textarea 内の `@path` 参照
- `@path` 入力中の workspace file path 候補表示は持たない
- 手入力または paste された `@path` は送信時に検証し、存在しない path は composer feedback として表示して送信しない
- picker で選んだ file / folder / image も textarea に `@path` を挿入する
- 添付 picker は初回だけ workspace を開き、以後は最後に選んだディレクトリを開く
- composer toolbar に `Add Directory` を置き、その横の toggle から `Additional Directories` 一覧を既定 closed で開閉できるようにする
- composer 下の `Approval / Model / Depth`
  - approval chip は `自動実行 / 安全寄り / プロバイダー判断`
  - approval chip は single-select control として矢印キーで切り替えられる
- session title は mate `main`
- assistant / pending bubble は `sub` ベースの薄い accent を持つ
- `composer settings` の背景は `sub` ベースの薄い accent を持つ
- `Send / Cancel` は mate `main`
- sendability 判定は `src/App.tsx` の単一導出に寄せ、`sessionExecutionBlockedReason` / `composerPreview.errors` を Send 近傍の単一 feedback area で扱う
- 実行中の latest command 監視の詳細は `docs/design/session-live-activity-monitor.md` を参照する
- Send disabled 条件は submit button / `Ctrl+Enter` / `Cmd+Enter` guard で一致させ、blank / whitespace-only draft の no-op 送信を通さない
- blank / whitespace-only draft は通常時は helper 文言を常時出さないが、blocked 送信ショートカットを押した時だけ inline reason を見せる
- send button の `title` には current blocked reason を載せ、hover でも送信不可理由を確認できるようにする
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
- `Audit Log` overlay と inline `Diff Viewer` overlay は open 時に dialog 内へ focus を移し、`Escape` で閉じ、`Tab` / `Shift+Tab` を dialog 内で循環させる

## Diff Window

- side-by-side split diff
- 縦スクロール同期
- 横スクロール同期
- 長い行は横スクロールで読む
- 狭幅では `Before / After` を縦 stack に倒し、必要な横 scroll は各 pane 内で扱う
- current minimum は `900px` 台の split-screen を想定し、stack 後も読める下限に寄せる
- `Before / After` の各 pane head / body は keyboard focus を受けられ、矢印キー、`PageUp` / `PageDown`、`Home` / `End` で scroll できる
- Session から開いた Diff は mate theme snapshot を引き継ぎ、`titlebar / subbar / pane header` にだけ薄い accent を持つ
- `Before / After` 見出しは差分面から独立した label chip として表示し、背景色に埋もれないコントラストを維持する

## Interaction Notes

- Home から Session / Settings / Session Monitor を開く
- Session の作成・更新・削除は Main Process 経由で永続化する
- Session の実行中イベントは Main Process から live state として IPC 中継する
- Home の `Session Monitor` は Main Process の `sessionWindows` を thin IPC bridge で参照し、開いている `Session Window` の session だけを表示する
- `Session Monitor Window` も同じ IPC bridge と truth source を使い、`Home` と別 window でも monitor 内容を同期する
- Session 実行の監査ログは SQLite に保存し、Session Window から閲覧する
- chat message は限定的な rich text renderer で整形表示する
- `Settings Window` は app 共通 system prompt や Character 本文を編集しない。V5 Character 定義は `Character Editor Window` と session / companion snapshot を正本にする
- legacy mate は `userData/mate/` に残る場合がある
- `userData` は `<appData>/WithMate/` に固定する
- Session は mate の `main / sub` theme color snapshot を保持し、現在は header title、assistant / pending bubble、composer settings、`Send / Cancel`、artifact block、Session から開く Diff の `titlebar / subbar / pane header` の限定的な accent に使う
- theme 由来の前景色決定は輝度閾値ではなく共通 contrast helper を正本にし、Home / Character Editor / Session / Diff で同じ WCAG AA 基準を使う
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
