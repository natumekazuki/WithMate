# Plan

## Goal

- Session composer で、`送れるか / 何が送られるか / 何を直せば送れるか` を Send 周辺だけで判断できる UX にする
- session-level blocked reason、input-level error、blank draft の分裂した sendability feedback を 1 つの整理された導線へ統合する
- attachment chip と `@path` 候補を、既存データ源のまま実用上の判別性を上げる
- same-plan の局所 UI/UX 改修に留め、persistent draft storage や新 API 追加には広げない

## Current Progress

- same-plan 実装は完了しており、`src/App.tsx` / `src/styles.css` の composer UX 変更と `docs/design/desktop-ui.md` の同期まで反映済み
- repo レベル検証は完了しており、`npm run typecheck` / `npm run build` は pass、quality-reviewer でも重大指摘なし
- manual test は未完了で、composer UX の `MT-047`〜`MT-051` と retry / interruption 非回帰の `MT-038`〜`MT-046` が gap として残っている
- dirty worktree には前 task `docs/plans/20260320-session-interruption-retry-ux/` を含む未コミット差分が残っているため、commit / archive は保留とする

## Reviewed Facts

- `sessionExecutionBlockedReason` は composer 上部 banner に出ており、Send 近傍で判断できない
- `composerPreview.errors` は別の error list として出ており、送信不可理由が session-level と input-level で分裂している
- blank / whitespace draft は Send ボタンが無効にならず、送信しても no-op になる
- attachment chip は draft の `@path` 派生表示で、file / folder / image の識別、outside-workspace 表現、long path 表示が弱い
- `@path` 候補は bare `@` では開かず、query 非空の workspace file path 候補のみで、mouse selection 中心
- persistent draft 保持まで広げると new-plan 寄りになる
- baseline の `npm run typecheck` / `npm run build` は pass 済み
- dirty worktree には `src/App.tsx`、`src/styles.css`、`docs/design/desktop-ui.md`、`docs/manual-test-checklist.md`、`docs/plans/20260320-session-interruption-retry-ux/`、`docs/plans/20260320-session-composer-ux/` の変更があり、composer UX 改修は前タスク差分と衝突注意で扱う必要がある

## Scope

- Session Window の composer 周辺 UI
- Sendability feedback の統合ルール
- attachment chip の視認性改善
- `@path` 候補 UI の見せ方と最小限の操作性改善
- retry / interruption task と重なる composer 領域の非退行条件整理
- 実装着手用の first slice は `src/App.tsx` / `src/styles.css` の局所変更に限定する

## Out of Scope

- provider 実行条件そのものの変更
- file picker / folder picker / image picker のネイティブ挙動変更
- `@path` 候補のデータ源拡張
  - bare `@` での候補全面表示
  - recent / favorite path の追加
  - folder / image 専用候補源の追加
- persistent draft storage、再起動復元、window 再生成をまたぐ draft 永続化
- message list、pending bubble、Audit Log overlay の再設計
- 新 API や storage schema の追加

## UX Principle

- 送信可否は Send ボタン近傍の 1 箇所で判断できるようにする
- 送信不可理由は「どの層の理由か」よりも「何を直せば送れるか」を優先して読めるようにする
- attachment は装飾よりも `何が送られるか` の読解性を優先する
- `@path` 候補は検索体験の全面刷新ではなく、既存候補を見失いにくく・キーボードでも選べる最小改善に留める
- retry banner を含む既存 composer UI と競合させず、同じ files の dirty 変更と安全にマージできる粒度へ抑える

## Recommended Implementation Direction

- 推奨案: `src/App.tsx` で `sessionExecutionBlockedReason`、`composerPreview.errors`、trim 済み draft 空判定から `composerSendabilityState` を導出し、Send / Cancel row 近傍の単一 feedback slot に表示を集約する
- 採用理由: 現在の問題は状態不足ではなく表示の分裂にあり、既存 state の再構成だけで same-plan に収まるため
- attachment chip は既存 `@path` 派生データのまま、type 表示、basename 優先、workspace 内外のラベル付け、long path の省略表示を強化する
- `@path` 候補は既存の `query 非空 + workspace file path` という表示条件を維持しつつ、row 情報整理と keyboard navigation を追加する
- draft は renderer local state の保護までに留め、永続保持は new-plan 候補として切り離す
- 実装時は retry / interruption task の banner 周辺差分と `src/App.tsx` / `src/styles.css` で重なるため、same-plan の局所変更として衝突注意を前提に進める

## Implementation Slice

### Slice A: sendability 判定の一本化

- `src/App.tsx` で以下を同じ判定源から導出する
  - trim 済み draft 空判定
  - session-level blocked reason
  - input-level error
  - Send button disabled
  - shortcut submit 可否
  - Send 近傍 feedback の本文
- submit handler と shortcut handler は、button disabled 条件と同じ sendability 判定を参照する
- composer 上部 banner 側に残る送信不可理由は撤去または Send 近傍 feedback に一本化し、二重表示を避ける

### Slice B: attachment chip の読みやすさ改善

- `src/App.tsx` で chip 表示用の軽量 helper を追加し、kind、basename、supplementary path、workspace 内外ラベルを組み立てる
- `src/styles.css` で chip の primary / secondary 情報の視覚階層と truncation を調整する
- 追加 metadata 取得や picker 挙動変更は行わない

### Slice C: `@path` 候補の見せ方改善

- `src/App.tsx` で候補 open 中だけ有効な active index と keyboard navigation を扱う
- `ArrowUp` / `ArrowDown` は active row 移動、`Enter` / `Tab` は採用、`Escape` は close に限定する
- textarea 通常操作を壊さないよう、候補 open かつ IME composition でない場合だけ専用 key handling を適用する
- `src/styles.css` で active / hover state、basename 優先表示、補足 path 表示を調整する

### Slice D: merge-safe 実装順

- 先に state 導出と submit guard を追加する
- 次に feedback slot を Send row 近傍へ寄せる
- その後 attachment chip と `@path` 候補の見た目を整える
- `src/App.tsx` / `src/styles.css` の dirty 差分競合を広げないため、レイアウト全面再編は避ける

## Acceptance Criteria

### 1. Sendability feedback の統合

- Sendability feedback は composer 上部 banner と Send 近傍で分裂させず、Send / Cancel action row の近傍にある単一の feedback area を主表示にする
- feedback area では以下を同じルールで扱う
  - session-level blocked reason
  - input-level error
  - blank / whitespace-only draft
- `runState === "running"` 中は `Cancel` が主役のため、sendability feedback で送信不可理由を重ねて主張しない

### 1.1 Sendability state matrix

| 条件 | Send ボタン | feedback | 補足 |
| --- | --- | --- | --- |
| `runState === "running"` | `Send` 非表示、`Cancel` 表示 | 送信不可説明を主表示しない | 既存 running UX を維持 |
| `sessionExecutionBlockedReason` あり | disabled | session-level reason を最上位で表示 | input-level error があれば同領域内で併記可 |
| `composerPreview.errors.length > 0` | disabled | input-level error を同領域で表示 | block reason がない場合の主理由 |
| draft が blank / whitespace-only | disabled | `メッセージを入力してください` 相当の短い helper を表示 | no-op 送信を禁止 |
| 上記いずれでもない | enabled | 追加 error/helper なし | 通常送信可 |

### 1.2 優先順位と表示ルール

- session-level blocked reason は送信不能理由として最優先に扱う
- input-level error は session-level blocked reason の下位詳細、またはそれがない場合の主理由として扱う
- blank / whitespace helper は他の block reason や input error がない場合にだけ表示する
- `Ctrl+Enter` / `Cmd+Enter` を含む送信導線は、button enabled 条件と同じ sendability 判定を使う
- blank / whitespace draft の submit は no-op のまま通さず、明示的に blocked 扱いにそろえる
- composer 上部の旧 blocked banner を残す場合でも、Sendability の主説明としては使わず、Send 近傍 feedback と文言・優先順位が矛盾しない

### 2. attachment chip の今回スコープ

- chip は file / folder / image を視覚的に判別できる
  - icon、type badge、または同等の軽量な区別手段を持つ
- chip の主表示は basename 優先とし、親 path や補足は副次表示へ回す
- workspace 内 path は workspace-relative 表示を優先する
- workspace 外 path は `ワークスペース外` と即判別できる短いラベルを出す
- long path は basename を殺さない省略表示にする
  - 末尾だけでなく basename が読める truncation を優先する
- 既存の picker / `@path` 解決結果から得られる情報の範囲で改善し、新しい metadata 取得や native picker 変更には踏み込まない

### 3. `@path` 候補 UI の今回スコープ

- 候補の表示条件は現行どおり `@` 後の query が非空である場合に限る
- 候補データ源は現行どおり workspace file path 候補に留める
- 候補 row は basename と親 path / workspace-relative path を見分けやすく整理する
- active row が視認できる hover / focus / keyboard highlight を持つ
- keyboard navigation は same-plan の範囲に含める
  - `ArrowUp` / `ArrowDown` で active row 移動
  - `Enter` または `Tab` で active row を採用
  - `Escape` で候補を閉じる
- IME composition 中や候補非表示時は textarea 既定操作を優先する
- mouse selection は維持し、keyboard 追加で退行させない
- 今回は以下を追加しない
  - bare `@` での候補表示
  - 候補の複数 source 統合
  - fuzzy search / ranking ロジック刷新

### 4. draft 保持の今回スコープ

- current task では renderer local state 上の draft 保護と sendability 整理までを扱う
- retry / interruption task で定義済みの `編集して再送` 時の draft 衝突保護を壊さない
- app 再起動、window 再生成、永続 storage をまたぐ draft 保持は今回やらない
- persistent draft storage は `new-plan` 候補として plan 上で分離する

### 5. retry / interruption UX との非競合条件

- composer sendability feedback を追加しても retry banner の状態識別と CTA を押し流さない
- `src/App.tsx` / `src/styles.css` / `docs/design/desktop-ui.md` / `docs/manual-test-checklist.md` は前 task 差分と重なるため、merge 時に retry banner の copy / details toggle / draft conflict notice を毀損しない
- sendability area、attachment chip、`@path` 候補の追加で composer 高さが増えても、retry banner と action row の情報階層が崩れない

## Same-Plan / New-Plan Boundary

### same-plan で扱う範囲

- `src/App.tsx` 内で完結する sendability feedback の統合
- blank / whitespace draft を disabled 条件へ含める局所 UI / submit guard 整理
- attachment chip の表示改善
- 既存 `@path` 候補の見た目整理と keyboard navigation 追加
- retry / interruption UX との非退行確認
- 必要最小限の docs 同期準備

### new-plan に分離すべき領域

- persistent draft storage
- app 再起動や window reopen 後の draft 復元
- bare `@` 候補表示や source 拡張を伴う `@path` 検索体験の再設計
- attachment metadata や native picker 挙動を拡張する改修
- provider 条件や session runtime の変更

### リファクタ判定

- 判定: `same-plan`
- 理由: 今回の変更は Session composer 周辺の UI state 整理と表示改善で閉じており、目的・変更範囲・検証軸が active plan と一致するため
- 想定影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- 検証観点: sendability 判定の一貫性、retry banner 非退行、keyboard navigation の textarea 干渉有無、chip 可読性、blank draft の no-op 排除

## Task List

- [x] 初期 plan を作成する
- [x] review 事実を plan に反映する
- [x] sendability feedback の統合方針を決める
- [x] attachment chip の今回スコープを決める
- [x] `@path` 候補 UI の今回スコープを決める
- [x] draft 保持の same-plan / new-plan 境界を決める
- [x] retry / interruption task と重なる衝突リスクを明記する
- [x] 実装着手用 first slice を `src/App.tsx` / `src/styles.css` に限定する
- [x] `src/App.tsx` で sendability state / submit guard / `@path` navigation を更新する
- [x] `src/styles.css` で feedback / chip / candidate state を更新する
- [x] dirty worktree 差分と retry banner 非退行を目視確認する
- [x] docs 同期が必要なら競合安全なタイミングで最小反映する
- [x] `npm run typecheck` / `npm run build` を再実行する
- [x] quality-reviewer の確認結果を artefact に反映する
- [x] docs-sync 判定を artefact に反映する
- [ ] manual test を実施する
- [ ] commit / archive 判断に進める

## Affected Files

- `src/App.tsx`
  - first slice の主実装点。sendability state 導出、blank draft 判定、submit guard、attachment chip 表示、`@path` 候補 keyboard navigation、retry banner 非競合の制御点が集中するため
- `src/styles.css`
  - feedback area、chip の type / path 表示、candidate active state、retry banner との高さ整理が必要になるため

## Deferred-Until-Safe Files

- `docs/design/desktop-ui.md`
  - same-plan の docs 同期対象だが、dirty worktree 競合を増やさないため code slice 完了後に必要最小限で扱う
- `docs/manual-test-checklist.md`
  - manual test の追記先候補だが、実装着手の前提ファイルには含めない

## Risks

- `src/App.tsx` / `src/styles.css` が dirty worktree かつ interruption / retry task と重なるため、差分競合で既存 banner 挙動を壊す恐れがある
- button disabled 条件と submit handler の trim 判定がずれると、blank draft no-op が再発する
- session-level blocked reason と input-level error の同時表示で情報密度が上がりすぎる恐れがある
- `@path` keyboard navigation が textarea の Enter / Tab / IME 操作と衝突する恐れがある
- chip 表示改善は既存 metadata の範囲に制約されるため、type 判定や outside-workspace 表示に edge case が残る可能性がある
- persistent draft を今回見送るため、再起動後復元までは改善されない
- docs 同期を同時に進めると dirty worktree の競合面が広がるため、コード first で分離する必要がある

## Validation

- 実装前 baseline
  - `npm run typecheck`: pass
  - `npm run build`: pass
- 実装後の再確認
  - `npm run typecheck`: pass
  - `npm run build`: pass
- review 結果
  - quality-reviewer: 重大指摘なし
- docs-sync 判定
  - `docs/design/desktop-ui.md`: 更新済み
  - `.ai_context/`: 更新不要
  - `README.md`: 更新不要
- manual test 観点
  - session-level blocked reason / input-level error / blank draft が Send 近傍の 1 箇所で判断できる
  - blank / whitespace-only draft で Send が disabled になり、`Ctrl+Enter` / `Cmd+Enter` でも no-op 送信しない
  - block reason と input error が同時にある場合でも優先順位が崩れない
  - attachment chip で file / folder / image の見分けがつき、workspace 外 path と long path が読める
  - `@path` 候補が query 非空時のみ出る現行仕様を維持しつつ、mouse / keyboard の両方で選択できる
  - `ArrowUp` / `ArrowDown` / `Enter` / `Tab` / `Escape` が textarea 操作と過剰に競合しない
  - retry banner、draft conflict notice、details toggle、`Cancel` 表示、scroll follow を退行させない
  - 追加確認: `runState === "running"` では Send feedback が主張しすぎず `Cancel` 主体の既存 UX を維持する
  - 追加確認: 候補 open 中だけ keyboard navigation が働き、候補 closed 時の Enter / Tab は既存 textarea 挙動を維持する
  - 追加確認: basename が長い path でも chip 主表示で何を添付したか判読できる
  - 未実施 gap: `MT-038`〜`MT-046`（retry / interruption 非回帰）、`MT-047`〜`MT-051`（composer UX）

## Completion State

- 実装状態: 完了
- repo 検証状態: 完了（`npm run typecheck` / `npm run build` pass、quality-reviewer 重大指摘なし）
- docs-sync 状態: 完了（`docs/design/desktop-ui.md` 更新済み、`.ai_context/` / `README.md` は更新不要）
- manual test 状態: 未完了（`MT-038`〜`MT-046`、`MT-047`〜`MT-051` が未実施）
- commit / archive 状態: 保留（manual test gap が残っており、dirty worktree に前 task `docs/plans/20260320-session-interruption-retry-ux/` を含む未コミット差分があるため）

## Completion Conditions

- same-plan の実装者が sendability feedback の統合ルールを追加解釈なしで実装できる
- blank draft を disabled 条件へ含めることと submit guard の整合が plan 上で明文化されている
- attachment chip の改善範囲が「type / basename / workspace 内外 / long path」までに限定されている
- `@path` 候補 UI の改善範囲が「既存候補の見せ方 + keyboard navigation」までで、bare `@` や source 拡張を含まないことが明示されている
- persistent draft storage が new-plan 境界として切り出されている
- overlapping dirty files と retry task への衝突注意が plan に残っている

## Design Doc Check

- 状態: current task 範囲の同期完了
- 更新済み: `docs/design/desktop-ui.md`
- 更新不要: `.ai_context/`, `README.md`
- メモ: manual test checklist の消化自体は未完了だが、docs-sync 判定として追加更新は不要
