# Decisions

## Summary

- interruption / retry UX は troubleshooting 画面ではなく、再開導線として設計する
- cancel 判定は assistant copy ではなく Audit Log terminal phase を真実源として扱う
- `同じ依頼を再送` と `編集して再送` は既存機能の組み合わせで実装し、新 API は追加しない
- retry banner は状態別 body 段落を削除し、generic fallback と draft conflict notice も短文 copy へ寄せる
- retry banner 詳細部は共通 toggle で開閉できるようにし、collapse state は renderer local state に分離する

## Decision Log

### 0001

- 日時: 2026-03-20
- 論点: 中断後の Session UI は何を主役にすべきか
- 判断: 原因説明よりも `同じ依頼を再送` と `編集して再送` の 2 導線を主役にする
- 理由: coding agent UI で中断後に最も価値が高いのは、状況理解よりも再開しやすさだから
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`

### 0002

- 日時: 2026-03-20
- 論点: `canceled` をどの state から判定するか
- 判断: 専用 runState がないため、`runState === "idle"` 単独ではなく最新 terminal Audit Log `phase === "canceled"` を真実源として使う
- 理由: assistant copy や idle 復帰後の見た目だけでは canceled と通常 idle を安全に区別できないため
- 影響範囲: `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0003

- 日時: 2026-03-20
- 論点: retry CTA の実装境界をどこまで広げるか
- 判断: `同じ依頼を再送` は既存 `handleResendLastMessage()`、`編集して再送` は draft 反映 + focus で実装し、新 API や storage 変更は行わない
- 理由: 既存 renderer state だけで要求 UX を満たせ、same-plan の局所変更に留められるため
- 影響範囲: `src/App.tsx`, `src/styles.css`

### 0004

- 日時: 2026-03-20
- 論点: interrupted の停止地点が不明なケースをどう扱うか
- 判断: 停止地点を断定できる情報がない場合は generic fallback copy を許容する
- 理由: recovery 起因の interrupted では停止詳細が欠けることがあり、推測表示のほうが誤解を招くため
- 影響範囲: `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0005

- 日時: 2026-03-20
- 論点: この変更に含めるリファクタ境界はどこか
- 判断: Session Window の局所 UI/UX と docs sync は same-plan、schema 追加や runtime/recovery 改修は new-plan とする
- 理由: 現タスクの完了条件は renderer 側の状態導出と copy 整理で満たせ、独立した永続化・runtime 変更は目的も検証軸も別になるため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0006

- 日時: 2026-03-20
- 論点: draft 非空時の `編集して再送` で入力中テキストをどう保護するか
- 判断: native confirm ではなく、retry banner 内に「下書きはそのまま残している」と分かる置換 notice と `前回の依頼で置き換える` CTA を追加する
- 理由: silent overwrite を避けつつ、現在の composer 文脈の中で何が起きるかを明示でき、same-plan の局所 UI だけで実装できるため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`

### 0007

- 日時: 2026-03-20
- 論点: retry banner と draft conflict notice の説明文をどこまで削るか
- 判断: 状態別 body 段落は削除または極小化し、badge / title / CTA / `前回の依頼` / `停止地点` ラベルを残して状態識別と行動判断を担保する。generic fallback と draft conflict notice も CTA 説明を含まない短文へ寄せる
- 理由: ユーザー要望が「説明が多すぎる」「ボタンで大体理解できるだろうから説明文は削っていい」であり、codebase-researcher も同箇所を冗長と指摘しているため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`

### 0008

- 日時: 2026-03-20
- 論点: `canceled` だけを個別対応するか、retry banner 共通で details toggle を持たせるか
- 判断: retry banner 共通で `Details` / `Hide` 相当の toggle を持たせる。ただし default は `canceled` を collapsed、failed / `interrupted` を expanded とする
- 理由: 実装は 1 つの banner パターンへ集約したほうが自然で、今後の状態追加でも説明しやすい。一方で今回の主目的は `canceled` の圧迫感解消なので、default collapsed は `canceled` を優先するのが UX 上の狙いに合うため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`

### 0009

- 日時: 2026-03-20
- 論点: `停止地点` / `前回の依頼` / draft conflict notice のどこまでを折りたたみ対象にするか
- 判断: 折りたたみ対象は `停止地点` と `前回の依頼` を中心にし、draft conflict notice と `前回の依頼で置き換える` 導線は常時表示に残す
- 理由: 高さの主因は `停止地点` と `前回の依頼` であり、draft conflict notice は入力保護のための操作導線なので隠すべきではないため
- 影響範囲: `src/App.tsx`, `src/styles.css`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`

### 0010

- 日時: 2026-03-20
- 論点: details 開閉 state の reset 条件をどこで切るか
- 判断: collapse state は renderer local state とし、session 切替または retry banner identity 変化時に default へ reset する。同一 banner identity 上の draft 編集や軽微な再描画では保持する
- 理由: 真実源と UI state を分離しつつ、別 session や別 interruption を前回の open / closed state が汚染しないようにするため
- 影響範囲: `src/App.tsx`, `docs/design/desktop-ui.md`, `docs/manual-test-checklist.md`
- リファクタ判定: `same-plan`
