# Plan

## Goal

- Session Window で実行が `interrupted` / `error` / user cancel に終わったあと、ユーザーが次の一手を即判断できる再開導線を定義する
- `何が起きたか`、`どこまで進んだか`、`どう再試行するか` を最小限の UI で示し、badge / title / CTA を主役にした retry UX として成立させる
- 既存の `handleResendLastMessage()`、composer draft、Audit Log を使い、新 API 追加なしで実装者へ渡せる粒度まで仕様を固める

## Reviewed Facts

- `runState === "interrupted"` はアプリ再起動時の recovery 用であり、failed と同義ではない
- `runState === "error"` は failed 相当として扱う
- cancel 専用の `runState` はなく、Cancel 完了後は最終的に `runState === "idle"` へ戻る
- Cancel 判定は assistant copy ではなく Audit Log の最新 terminal `phase` を真実源にするほうが安全
- `handleResendLastMessage()` は既存実装があり、新しい retry API は不要
- `編集して再送` は `setDraft(lastUserMessage.text)` と textarea focus で実現できる
- interrupted は停止地点の詳細が欠ける場合があるため、generic fallback を許容する必要がある
- codebase-researcher の判断では、この変更は same-plan の局所 UI/UX 変更で完結可能
- 現在の retry banner は状態別 body 段落が CTA の説明を文章で繰り返しており、generic fallback と draft conflict notice もやや長い
- badge / title / CTA / `前回の依頼` / `停止地点` ラベルは残したほうが自然で、説明文だけを削る方向が適切
- 現在 `canceled` / failed / `interrupted` の retry banner は composer 上に常時表示され、高さの大半を `停止地点` と `前回の依頼` ブロックが占めている
- 既存 UI で最も近い開閉パターンは artifact の `Details` / `Hide` toggle で、汎用 collapse helper は見当たらない
- collapse state は canceled 判定などの真実源と混ぜず、`src/App.tsx` の renderer local state として持つのが自然

## Scope

- Session Window の retry / resume banner と composer 周辺 UX
- `interrupted` / failed / canceled 後に出す copy、CTA、停止地点サマリの表示ルール
- `同じ依頼を再送` と `編集して再送` の動作差、draft 衝突時の扱い
- retry banner の冗長な説明文、停止地点 fallback、draft conflict notice の短文化
- retry banner 詳細部の開閉 UX、default state、reset 条件
- pending indicator / scroll follow の非退行条件整理
- `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` の同期

## Out of Scope

- audit log schema、session schema、cancel event payload の変更
- provider / runtime / recovery 処理そのものの変更
- Home 一覧や通知、Diff、Audit Log overlay 自体の情報設計変更
- pending bubble 全体の再設計
- interrupted 時の詳細な停止地点メタデータを新規保存する改修

## UX Principle

- 中断後は原因説明よりも、再開に必要な CTA を先に見せる
- 状態識別は badge / title で担保し、説明文で CTA を繰り返さない
- CTA は `同じ依頼を再送` と `編集して再送` の 2 本を主軸にし、通常送信導線と競合させない
- `ユーザーが止めた`、`実行エラーで失敗した`、`再起動復帰の interrupted` は copy を切り分ける
- 停止地点は Audit Log / live run / 直近 artifact から短く要約し、詳細が取れないときも短い fallback で止める
- `前回の依頼` / `停止地点` ラベルは残し、説明段落だけを削って情報の見出し性は維持する
- retry banner は badge / title / CTA を常時見せ、詳細情報だけを `Details` / `Hide` 相当で開閉できるようにする
- 圧迫感の解消を主目的に、default collapsed はまず `canceled` を優先し、failed / `interrupted` は情報発見性を保つ
- draft conflict notice は操作導線なので、詳細開閉に巻き込まず見落としにくさを優先する
- 既存の message follow mode、pending indicator、composer 入力体験を壊さない

## Recommended Implementation Direction

- 推奨案: `src/App.tsx` 内で「retry banner 用の派生 state」を組み立て、`selectedSession.runState`、最新 Audit Log terminal phase、`lastUserMessage`、current draft の組み合わせで banner 種別と CTA 活性条件を決める。あわせて details 開閉 state を renderer local state で持ち、banner identity 変化時に default へ reset する
- 採用理由: 既存の session / audit / composer state だけで完結し、Main Process や storage schema へ広げず same-plan に収まるため。汎用 helper を増やさず既存 artifact toggle に近い局所実装へ寄せられるため
- follow-up 方針: 既存 banner 構造は大きく変えず、状態別 body 段落を削除または極小化し、badge / title / CTA / ラベル群が主役になる copy 密度へ寄せる
- follow-up 方針 2: details toggle は retry banner 共通で持たせるが、default は `canceled` を collapsed、failed / `interrupted` を expanded とし、今回の主目的である `canceled` の圧迫感解消を優先する

## Acceptance Criteria

### 1. 状態別 CTA 表示条件

| 状態 | 判定基準 | 表示 | 補足 |
| --- | --- | --- | --- |
| running | `selectedSession.runState === "running"` | retry banner 非表示 | 既存 pending / `Cancel` を維持 |
| interrupted | `selectedSession.runState === "interrupted"` かつ `lastUserMessage` あり | retry banner 表示 | recovery 起因として扱い、failed copy に寄せない |
| failed | `selectedSession.runState === "error"` かつ `lastUserMessage` あり | retry banner 表示 | `error` は failed copy を表示 |
| canceled | `selectedSession.runState === "idle"` かつ最新 terminal Audit Log `phase === "canceled"` かつ `lastUserMessage` あり | retry banner 表示 | assistant copy からは判定しない |
| 通常 idle | `runState === "idle"` で canceled 判定にも failed/interrupted 判定にも該当しない | retry banner 非表示 | 通常 composer のみ |
| lastUserMessage なし | 上記いずれでも user message が見つからない | retry banner 非表示 | retry 不能のため CTA を出さない |

### 2. CTA の動作差

- `同じ依頼を再送`
  - `lastUserMessage.text` をそのまま送信する
  - 既存 `handleResendLastMessage()` を利用する
  - composer draft を自動で書き換えない
- `編集して再送`
  - `lastUserMessage.text` を draft へ入れる
  - textarea に focus を戻し、必要なら caret を末尾へ置く
  - 自動送信しない

### 3. draft が既にある場合の扱い

- current draft が空なら `編集して再送` はそのまま `lastUserMessage.text` を入れてよい
- current draft が非空なら silent overwrite をしない
- same-plan の範囲では、最小実装として confirm を挟むか、既存 draft を保持したまま明示的に置換する UX のどちらかを選び、採用案を `decisions.md` に残す
- どちらの案でも「意図せず入力中の文面を失わない」ことを acceptance criteria とする

### 4. 詳細開閉 UX

- retry banner には状態共通で `Details` / `Hide` 相当の toggle を置き、badge / title / CTA の近くで発見できるようにする
- 常時表示する要素:
  - badge
  - title
  - CTA 群
  - draft conflict notice と、その配下の `前回の依頼で置き換える` 導線
- 折りたたみ対象:
  - `停止地点`
  - `前回の依頼`
  - 上記に付随する短い fallback / summary
- default state:
  - `canceled`: collapsed
  - failed: expanded
  - `interrupted`: expanded
- toggle copy は artifact と同程度に簡潔にし、`Details` / `Hide` 相当の 2 状態で十分とする
- collapsed 時でも、状態識別と retry 可否は badge / title / CTA だけで判断できること

### 5. 状態別 copy ルール

- 共通:
  - badge / title / CTA を主役にし、body 説明で CTA の意味を繰り返さない
  - 状態別 body 段落は削除を第一候補とし、残す場合でも 1 文以内の補助情報に留める
  - `前回の依頼` / `停止地点` ラベルは維持する
- interrupted:
  - badge / title で `中断された` / `再開していない` 系を示し、failed と断定しない
  - 停止地点不明なら generic fallback を許容する
- failed:
  - badge / title で `エラーで完了できなかった` と分かる表現にする
- canceled:
  - badge / title で `あなたが停止した` と読める表現にする
  - system error と混同させない

### 6. 停止地点サマリと fallback

- 停止地点サマリは、可能なら直近の visible step / artifact operation / Audit Log operations から 1 行で要約する
- interrupted では停止地点情報が欠けることがあるため、詳細が取れない場合は CTA 説明を含まない短い generic fallback を許容する
- fallback 採用条件は少なくとも以下を含む
  - 最新 terminal Audit Log に有意な operation summary がない
  - liveRun が既に消えていて停止直前の step を復元できない
  - artifact から停止地点を断定すると誤解を招く

### 6.1 draft conflict notice の短文化

- draft conflict notice は「今の下書きは保持されている」ことと「前回の依頼で置き換える」CTA だけが即分かる短さにする
- 長い説明文や手順説明は避け、retry banner の主 CTA より目立たせない
- draft 保護の意図は維持しつつ、banner 全体の読み量を増やさない
- draft conflict notice は details collapse の外側に置き、collapsed 時でも操作導線が隠れないようにする

### 7. details state の reset 条件

- collapse state は renderer local state とし、canceled 判定や runState などの真実源には保存しない
- 以下のいずれかで details state を default へ reset する
  - session 切替で別 session を表示したとき
  - retry banner identity が変わったとき
    - banner kind が変わる
    - `lastUserMessage` が変わる
    - canceled 判定に使う最新 terminal Audit Log entry が変わる
- 同一 banner identity のまま message list 更新や draft 編集だけが起きても、ユーザーが選んだ open / closed state は保持する

### 8. disabled 条件

- retry CTA は以下のいずれかで disabled になる
  - `sessionExecutionBlockedReason` がある
  - `lastUserMessage` がない
  - 既に `runState === "running"` に戻っている
- `編集して再送` は textarea が disabled になる状況では押せない
- `同じ依頼を再送` は送信不能理由が UI copy から分かること

### 9. 非退行条件

- `runState === "running"` 中の pending indicator の copy / persistence 仕様を壊さない
- message list の scroll follow は、retry banner 出現や draft 挿入で不要に末尾へジャンプしない
- details toggle の開閉で message list や composer が不自然にジャンプしない
- 追従停止中に retry banner が出ても `新着あり` / `読み返し中` の導線を壊さない
- `Cancel` ボタン、textarea disabled、`Send` ボタン活性条件の既存契約を崩さない

### 10. Manual Test 追加観点

- interrupted / failed / canceled それぞれで banner copy と CTA が切り替わる
- interrupted / failed / canceled の識別性が body 段落なしでも badge / title で維持される
- canceled は `runState === "idle"` でも Audit Log `phase === "canceled"` から判定できる
- `同じ依頼を再送` は即送信、`編集して再送` は draft 反映 + focus のみ
- draft 非空時に `編集して再送` を押しても、入力中テキストが意図せず失われない
- 停止地点 fallback と draft conflict notice が短文化されても意味が失われない
- `canceled` は初期表示で details collapsed、failed / `interrupted` は初期表示で details expanded になる
- `Details` / `Hide` toggle で `停止地点` / `前回の依頼` が開閉し、badge / title / CTA は常時残る
- session 切替や retry banner identity 変化で details state が reset し、同一 banner 上の draft 編集では reset しない
- draft conflict notice は collapsed 時でも見えており、置換導線を失わない
- last user message がない session では retry banner が出ない
- retry banner 表示後も pending indicator と scroll follow の既存期待結果が維持される
- session A の canceled / live run 表示中に session B へ切り替えても、retry banner 判定、`停止地点` summary、pending / live run、Audit Log が session A を引きずらない

## Same-Plan / New-Plan Boundary

### same-plan で扱う範囲

- `src/App.tsx` 内で完結する retry banner の state 導出、copy 分岐、CTA ハンドラ追加
- `src/App.tsx` 内での details toggle state、default collapsed、reset 制御
- `src/styles.css` の局所スタイル調整
- `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` の同期
- draft 保護のための局所 confirm / notice / button state 調整

### new-plan に分離すべき領域

- audit log へ cancel / interruption の詳細メタデータを追加する改修
- session 永続 state に cancel 専用 runState や retry 履歴を保存する改修
- Home 一覧、通知、Diff、監査ログ viewer まで含む広域な interruption UX 統一
- recovery 仕様そのものの変更や interrupted reason の詳細復元ロジック追加

### リファクタ判定

- 判定: `same-plan`
- 理由: 今回の follow-up は retry banner の詳細開閉と draft conflict notice の露出調整であり、目的・変更範囲・検証軸が現行 plan と一致するため
- 想定影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- 検証観点: 状態判定の誤分類防止、badge/title による識別性、details toggle default/reset、draft 保護、focus、scroll follow 非退行、pending indicator 非退行

## Task List

- [x] Plan を作成する
- [x] 現行の interrupted / canceled 後 UI を確認する
- [x] 中断種別と停止地点の表示ルールを定義する
- [x] 再送導線の CTA 構成を確定する
- [x] Session interruption / retry UI を更新する
- [x] design doc / manual test を更新する
- [x] 追加ユーザーフィードバックを same-plan follow-up として plan に反映する
- [x] retry banner / fallback / draft conflict notice の copy を短文化する
- [x] retry banner details collapse follow-up を same-plan で扱う方針を決める
- [x] details toggle の default / reset / 折りたたみ対象を実装仕様として反映する
- [ ] 実装と検証を完了する

## Affected Files

- `src/App.tsx`
  - retry banner の表示判定、Audit Log ベースの canceled 判定、CTA ハンドラ、details toggle local state、draft/focus 制御、非退行条件の制御点が集中しているため
- `src/styles.css`
  - interrupted / failed / canceled banner と CTA 群、details toggle、collapsed section、disabled / emphasis 表現を局所追加する可能性が高いため
- `docs/design/desktop-ui.md`
  - Session Window の interrupted / retry UX 仕様を state matrix、copy ルール、details toggle ルール込みで正本化するため
- `docs/manual-test-checklist.md`
  - interrupted / failed / canceled / details collapse / draft conflict / scroll non-regression の実機観点を追加するため

## Affected Files Rationale for Non-Changes

- `src-electron/*`
  - 既存の Audit Log と resend 実装で要件を満たせるため、same-plan では変更対象に含めない
- storage schema
  - cancel 専用 runState や interruption metadata 追加は new-plan 領域とする

## Risks

- canceled 判定を Audit Log から引く実装で terminal entry の取り方を誤ると通常 idle に誤表示する
- body 説明を削りすぎると interrupted と failed の識別が崩れる
- details 開閉の default / reset を誤ると、別 session や別 banner の文脈で前回の open / closed state を引きずる
- draft conflict notice まで畳んでしまうと、入力保護と置換導線を見落としやすくなる
- draft 保護を曖昧にすると `編集して再送` で入力中内容を失う
- retry banner 追加が composer 高さや scroll follow の挙動へ影響する恐れがある

## Validation

- 状態遷移レビュー
  - `running → canceled(idle)`、`running → error`、再起動後 `interrupted` を想定した state matrix 確認
- UI 動作確認
  - `同じ依頼を再送`、`編集して再送`、draft 非空時の保護、disabled 条件、focus 位置
  - body 段落を削除または極小化しても badge / title / CTA だけで行動判断できること
  - `Details` / `Hide` 相当の toggle で `停止地点` / `前回の依頼` が開閉し、default と reset 条件が想定どおりであること
- 非退行確認
  - pending indicator、`Send / Cancel` 切替、message follow banner、textarea / composer attachment 操作
  - details toggle 開閉や session 切替で scroll follow と composer 高さが不自然に跳ねないこと
- ドキュメント同期
  - `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` が同じルールセットを参照していること
- 実施済み
  - `npm run typecheck`: pass
  - `npm run build`: pass
  - quality-reviewer: 重大指摘なし
- 未実施 / gap
  - manual test `MT-038`〜`MT-046`

## Completion State

- [x] repo plan に沿った UI 実装と docs sync
- [x] retry banner の body 段落削除、generic stop summary fallback 短文化、draft conflict notice 短文化
- [x] details collapse follow-up を same-plan として受け、方針・受け入れ条件・manual test 観点を plan artefact に反映
- [x] `npm run typecheck` / `npm run build` の pass
- [x] quality-reviewer で重大指摘なし
- [x] retry banner details toggle 実装と docs sync
- [ ] manual test `MT-038`〜`MT-046`
- [ ] commit / archive 判断
  - task 外の untracked path `docs/plans/20260320-session-composer-ux/` があるため保留

## Completion Conditions

- 実装者が state matrix と CTA 動作差を追加解釈なしで実装できる
- canceled / failed / interrupted の copy 切り分けと fallback 条件が、短文化方針込みで明文化されている
- retry banner details toggle の default / reset / 折りたたみ対象が、truth source 分離方針込みで明文化されている
- manual test 観点に details collapse、draft conflict、session 境界 no-bleed、非退行確認が含まれている
- new-plan に切るべき領域が plan 上で明示されている

## Design Doc Check

- 状態: 同期済み
- 対象候補: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- メモ: Session の interrupted / retry UX を、Audit Log を真実源に含む再開導線仕様として同期する
