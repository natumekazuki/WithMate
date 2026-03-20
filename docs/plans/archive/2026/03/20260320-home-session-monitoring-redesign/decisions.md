# Decisions

## Summary

- Home の `Recent Sessions` は resume picker の本体を維持しつつ、並列実行監視にも使えるようにする
- same-plan は Home renderer / CSS / docs sync に閉じ、真実源拡張や永続 state は new-plan へ分離する
- 2026-03-20 の最新 refinement では、3 カラム / slim collapsed rail を現 target から外し、「左 `Recent Sessions` / 右 `SessionMonitor` または `Characters`」の 2 カラムへ same-plan 継続で寄せる
- `SessionMonitor` の truth source は `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` を使い、renderer へは thin IPC / preload bridge で渡す
- right pane は segmented toggle / tab-like 2 択で排他的に切り替え、初期値は `SessionMonitor` とする
- 現時点の残作業は thin bridge 実装、2 カラム UI 更新、docs/manual 再同期、repo 検証、manual test、commit / archive 前確認

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: 実行中 session の一覧表示は chip と card のどちらを主役にすべきか
- 判断: card を主役に戻し、chip は shortcut 扱いへ落とす
- 理由: 並列実行の監視では「一覧から比較して状況を把握できること」の価値が高く、chip だけでは情報量が足りないため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`

### 0002

- 日時: 2026-03-20
- 論点: `Characters` panel は常時表示であるべきか
- 判断: fold / collapse を許可し、Home の主面積は Session list 側へ寄せる
- 理由: Home の主目的は session resume / monitoring / launch であり、character 管理は補助面に置いた方が全体の重心が安定するため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/home-ui-brushup.md`

### 0003

- 日時: 2026-03-20
- 論点: Home card の state precedence / badge は何を真実源にするか
- 判断: same-plan では既存 session fields から導出し、`status === "running"` または `runState === "running"` を最優先、次に `runState === "interrupted"`、次に `runState === "error"`、それ以外は neutral 扱いとする
- 理由: 現 task を renderer / CSS / docs sync の局所変更へ留めつつ、`status` と `runState` の二重管理で発生する曖昧さを Home だけで解消できるため
- 影響範囲: `src/HomeApp.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0004

- 日時: 2026-03-20
- 論点: card sort を active state 優先へ組み替えるべきか
- 判断: storage 既定順 `last_active_at DESC` をそのまま採用し、priority は badge と chip shortcut で補う
- 理由: 並びの真実源を増やさず、検索結果と card / chip の一貫性を保ちやすいため
- 影響範囲: `src/HomeApp.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0005

- 日時: 2026-03-20
- 論点: `Characters` collapse state をこの plan で永続化するべきか
- 判断: same-plan では default open + renderer local state に留め、永続化は new-plan 候補へ分離する
- 理由: 永続 state を入れると storage / settings / migration まで影響し、現在の変更範囲と検証軸を超えるため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/home-ui-brushup.md`

### 0006

- 日時: 2026-03-20
- 論点: 今回の redesign で独立 refactor を同梱するか
- 判断: Home 専用 class / layout modifier への局所整理は same-plan、shared CSS 設計や badge 真実源の再編は new-plan とする
- 理由: 完了条件を満たすための前提整理と、目的・影響範囲・検証軸が独立する改善を分離するため
- 影響範囲: `src/styles.css`, `docs/plans/20260320-home-session-monitoring-redesign/plan.md`

### 0007

- 日時: 2026-03-20
- 論点: Home 上の `runState === "error"` をどの日本語ラベルで出すか
- 判断: Home の badge / chip では `エラー` 表記を採用する
- 理由: `failed` より Home の監視一覧で自然に読め、既存 helper / manual test の「エラー」表現とも矛盾しにくいため
- 影響範囲: `src/HomeApp.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0008

- 日時: 2026-03-20
- 論点: Home の monitor / session list / characters をどの配置に置くべきか
- 判断: 左 = collapse 可能な起動中セッション monitor panel、中央 = `Recent Sessions` 本体、右 = collapse 可能な `Characters`
- 理由:
  - session list は Home の主面であり、中央に置く方が resume picker として自然なため
  - `running` / `interrupted` の shortcut は補助導線なので、左端の monitor panel に寄せる方が主従関係を保ちやすいため
  - 左端 collapse と相性がよいのは monitor 側であり、右側には既存の `Characters` 補助面を維持しやすいため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`

### 0009

- 日時: 2026-03-20
- 論点: 現行の Home 上部 chip row を monitor panel 導入後も残すべきか
- 判断: 独立した chip row は廃止し、monitor panel へ統合する
- 理由:
  - monitor panel を追加して chip row を残すと、shortcut と monitoring 情報が二重化するため
  - chip row は元々補助導線だったため、左 panel の item として吸収した方が構造が単純になるため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0010

- 日時: 2026-03-20
- 論点: `Characters` collapsed 時に `Add Character` を残すべきか
- 判断: refinement target では残さず、icon-only collapse button のみを出す
- 理由:
  - 今回の要望では collapsed 中の `Add Character` は不要であり、補助面を細く保つ方が 3 カラムの意図に合うため
  - expanded 時の header / empty state に導線を残せば、機能喪失なしで密度だけ下げられるため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`

### 0011

- 日時: 2026-03-20
- 論点: monitor panel の non-running section に何を含めるか
- 判断: `停止・完了` section に `interrupted` / `error` / neutral をまとめ、badge で状態差分を残す
- 理由:
  - monitor panel は compact な補助面なので、same-plan では最小 2 section に留めた方が密度と scan 性のバランスがよいため
  - `interrupted` / `error` を独立 section に分けずとも、badge で判別できれば「落とさない」要件を満たせるため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`

### 0012

- 日時: 2026-03-20
- 論点: collapse 後の左右 sidebar は chevron + 縦書きラベルを残すべきか
- 判断: chevron はやめて common sidebar の menu toggle に近い `≣` 風 icon-only button へ寄せ、collapsed rail は toggle だけを残す
- 理由:
  - 今回の follow-up 要望では「よくある sidebar」に近い簡素な collapsed 表示が求められているため
  - 左右差分は visible label ではなく `aria-label` で十分伝えられ、縦書きラベルを外した方が slim rail を維持しやすいため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`

### 0013

- 日時: 2026-03-20
- 論点: 今回の research 追加要望は `same-plan` か `new-plan` か
- 判断: `same-plan`
- 理由:
  - 変更の中心は Home の再レイアウト、right pane 切替、main/preload の薄い bridge、docs/manual 更新に留まるため
  - `SessionWindow` open state の truth source は既存の `sessionWindows` にあり、DB / Session schema 追加なしで要件を満たせるため
- 影響範囲: `src-electron/main.ts`, `src-electron/preload.ts`, `src/renderer-env.d.ts`, `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`

### 0014

- 日時: 2026-03-20
- 論点: `SessionMonitor` の表示対象は何を truth source にすべきか
- 判断: `src-electron/main.ts` の `sessionWindows: Map<string, BrowserWindow>` を truth source とし、renderer には open session window ids を thin IPC / preload bridge で渡す
- 理由:
  - 既に runtime 上で最も正確な open / close 状態を持っているのが `sessionWindows` であるため
  - DB / Session schema に open state が無く、same-plan で永続層へ拡張しない方が変更範囲と検証軸を抑えられるため
- 影響範囲: `src-electron/main.ts`, `src-electron/preload.ts`, `src/renderer-env.d.ts`, `src/HomeApp.tsx`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`

### 0015

- 日時: 2026-03-20
- 論点: Home は 3 カラムを維持すべきか、2 カラムへ戻すべきか
- 判断: 3 カラムをやめ、「左 = `Recent Sessions` / 右 = `SessionMonitor` または `Characters`」の 2 カラムへ戻す
- 理由:
  - `Recent Sessions` を主面として明確化し、monitor と character 管理を同じ右補助面へ収めた方が視線移動と密度が安定するため
  - 今回 target では左右 collapse を外すため、3 カラムより 2 カラムの方が要件との整合が高いため
  - 比率 6:4 前後で左主面 / 右補助面の主従が表現しやすいため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`

### 0016

- 日時: 2026-03-20
- 論点: 右ペイン切替 UI はどの表現を採用すべきか
- 判断: segmented toggle の見た目を基本とした tab-like 2 択 UI を採用し、初期値は `SessionMonitor` とする
- 理由:
  - 排他的な 2 機能切替を最短距離で表現でき、現在どちらを見ているかが一目で分かるため
  - 起動直後は monitoring を優先して見せる方が、Home redesign の主目的と合うため
  - collapse UX を外した今回 target では、segmented toggle の方が補助面の切替として自然であるため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/design/home-ui-brushup.md`, `docs/manual-test-checklist.md`

### 0017

- 日時: 2026-03-20
- 論点: Home の open session window ids はどう購読すれば race / stale を避けられるか
- 判断: `openSessionWindowIds` は mount 固定の effect で管理し、`launchCharacterId` 依存から分離したうえで「subscribe を先に張る → snapshot を取得する」順を採用する
- 理由:
  - `launchCharacterId` 変更のたびに購読を張り直すと、Launch Dialog 操作だけで monitor 側の truth source が stale になる時間帯が生まれるため
  - subscribe 開始後に snapshot を取得し、購読イベントを受けた後は snapshot で上書きしないようにすれば、初期取得と event 配信のすき間で open / close を取りこぼしにくいため
  - character 一覧側は functional update で `launchCharacterId` 整合を取れば、購読系 effect から選択 state を切り離せるため
- 影響範囲: `src/HomeApp.tsx`, `docs/plans/20260320-home-session-monitoring-redesign/worklog.md`, `docs/plans/20260320-home-session-monitoring-redesign/result.md`

### 0018

- 日時: 2026-03-20
- 論点: 追加の Home micro-refinement は `same-plan` か `new-plan` か
- 判断: `same-plan`
- 理由:
  - 変更は `src/HomeApp.tsx` / `src/styles.css` / `docs/manual-test-checklist.md` と plan artefact に閉じており、2 カラム / open session truth source / segmented toggle の既存完了条件を補強する範囲に留まるため
  - 新しい truth source、永続 state、main / preload の責務追加は不要で、独立した目的・検証軸を持つ別タスクには広がらないため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`, `docs/plans/20260320-home-session-monitoring-redesign/plan.md`

### 0019

- 日時: 2026-03-20
- 論点: right pane 内に `Session Monitor` / `Characters` の heading を残すべきか
- 判断: 上部 segmented toggle が active pane を十分示す前提で、pane 内 top heading は置かない
- 理由:
  - 現状の pane 内 heading は `src/HomeApp.tsx` に直書きされており、segmented toggle と同名ラベルが二重化して scan 性を下げているため
  - `Characters` / `SessionMonitor` の区別は toggle の active state で把握でき、pane 内ではその下の search / list / empty state に面積を返した方が密度が安定するため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`

### 0020

- 日時: 2026-03-20
- 論点: `SessionMonitor` の scroll 不発はどこを基準に直すべきか
- 判断: session list と同様に list 自体へ `overflow: auto` を持たせる構成へ寄せ、section wrapper 側の scroll 依存を外す
- 理由:
  - session list は list 自体が scroll container で安定しており、monitor 側だけ wrapper に scroll を持たせると height / min-height / overflow の伝播が崩れやすいため
  - same-plan では Home CSS / renderer の局所整理で解消でき、scroll 専用の大きなレイアウト再設計へ広げる必要がないため
- 影響範囲: `src/HomeApp.tsx`, `src/styles.css`, `docs/manual-test-checklist.md`
