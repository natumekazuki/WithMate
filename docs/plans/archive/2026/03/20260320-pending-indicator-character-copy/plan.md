# Plan

## Goal

- pending indicator 周辺の user-facing 文言を WithMate のキャラクターロールプレイ体験に寄せる
- 直近改修で入った pending indicator の visible text / screen reader text を、実装主体の説明ではなくキャラ名ベースの表現へ見直す
- UI copy 修正と docs sync を同じ論理変更単位で完了できる状態に整理する

## Scope

- `src/App.tsx` の pending indicator visible text
- `src/App.tsx` の pending indicator screen reader 向け文言
- `docs/design/desktop-ui.md` の pending indicator 説明
- `docs/manual-test-checklist.md` の pending indicator 関連期待結果
- 必要なら、行長変化に伴う軽微なレイアウト保護として `src/styles.css`

## Out of Scope

- pending indicator の表示条件や runState 制御の再設計
- `実行中` などの state label、`Command` などの type label、provider 名などのシステム用語の改名
- scroll follow banner (`新着あり`, `読み返し中`) の copy 見直し
- pending indicator 外へ広がる包括的な terminology refresh

## Current Issue

- pending indicator の user-facing copy が coding agent 実装を前面に出しており、WithMate のキャラ体験と少しズレる
- 特に pending indicator は assistant の振る舞いをユーザーへ直接見せる箇所のため、アプリコンセプトとの整合が見えやすい
- 一方で state / type / provider などのシステム用語までキャラクター寄りに寄せると、監視・診断・理解のしやすさを損ねる可能性がある

## Copy Policy

- user-facing assistant 状態文言は character 名ベースで扱う
- state / type / provider などのシステム用語は現状維持とする
- 主語を持たないナビゲーション文言や進行補助文言は、今回の task では無理に変更しない
- visible text と screen reader 向け文言は意味とトーンを同期させる

## Recommended Approach

- pending indicator の user-facing copy は、現在の session に紐づく character 名を主語または話者として使う案を第一候補とする
- 名前未取得時は coding agent 表現へ戻さず、主語なしまたは一般化した assistant 表現へ安全に degrade できる設計を優先する
- copy 変更で 1 行が伸びる場合のみ `src/styles.css` を局所調整し、レイアウト崩れ防止を同一 plan 内の前提作業として扱う

## Acceptance

- pending indicator の visible text が WithMate のキャラ体験に沿う
- pending indicator の screen reader 向け文言も同じ方針で同期される
- state / type / provider 系のシステム用語は変更されない
- `docs/design/desktop-ui.md` と `docs/manual-test-checklist.md` が UI copy 方針と期待結果に同期される
- copy 変更後も pending bubble 内のレイアウトが崩れない

## Task List

- [x] 新規 repo plan を作成する
- [x] scope / out of scope / copy policy を明文化する
- [x] session plan を今回の task 用に更新する
- [x] `src/App.tsx` の pending indicator visible text / screen reader text を更新する
- [x] 必要なら `src/styles.css` の軽微なレイアウト調整を行う
- [x] `docs/design/desktop-ui.md` を更新する
- [x] `docs/manual-test-checklist.md` を更新する
- [ ] 実装後の表示確認と docs sync を完了する

## Affected Files

- `src/App.tsx`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- 必要なら `src/styles.css`

## Risks

- character 名をそのまま文言へ載せると、長い名前で pending bubble の行長が伸びる可能性がある
- visible text だけ修正して screen reader 向け文言が旧 wording のまま残ると、体験が不整合になる
- pending indicator 周辺だけトーンを変えるため、システム用語まで誤って巻き込むと情報設計がぶれる
- copy 見直しが広範囲の terminology refresh に膨らむと、局所 task の粒度を超える

## Validation

- character 名表示が不自然でないこと
- 行長増加によるレイアウト崩れがないこと
- screen reader 向け文言も visible text と同じ方針で同期されること
- state / type / provider などのシステム用語が意図せず変わっていないこと
- docs の説明と manual test の期待結果が実装 copy に追従していること

## Refactor Triage

- same-plan: copy 差し替えに伴って必要になる pending indicator 周辺の軽微なレイアウト保護
- 理由: 完了条件である「自然な copy を崩れなく見せる」ための前提作業だから
- new-plan: pending indicator 外へ広がる terminology sweep や、state / type / provider 用語の再設計
- 理由: 目的と検証軸が UI copy 局所修正から独立するため

## Design Doc Check

- 状態: 更新対象あり
- 対象候補: `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- メモ: pending indicator の user-facing copy はキャラ名ベース、system 用語は現状維持という境界を同期する
