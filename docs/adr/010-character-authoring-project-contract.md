# ADR 010: Character authoring の Project contract

- Status: Accepted
- Date: 2026-08-01

## Context

`Improve with Agent` は保存済み Character directory を通常 Session の workspace として開き、agent が `character.md` と `character-notes.md` を直接改善する。従来は Editor draft と改善指示を起動 IPC に含め、Session 作成時に canonical files を書き直していた。また `character.md` の上限は runtime definition として過大な 128 KiB だった。

ChatGPT Project 形式の authoring 方針を取り込むにあたり、Editor UI、保存境界、provider 間の Skill 配置、既存 Character files の後方互換を揃える必要がある。Session の stable Character owner は ADR 009 を前提とする。

## Decision

### Character definition limit

- `character.md` は CRLF と CR を LF に正規化した後の Unicode code point 数で 8,000 文字以下とする。
- 8,000 文字は許可し、8,001 文字は拒否する。
- validation の canonical owner は `src/character/character-definition.ts` とする。Editor、create/update storage、import、runtime snapshot は同じ contract を使う。
- `character-notes.md` の 256 KiB 上限は維持する。

### Authoring launch boundary

- UI は `Improve with Agent`、provider 選択、`Start` の現行導線を維持する。
- 改善指示は起動前の専用入力ではなく、開始後の通常 Session composer から自然言語で受け取る。
- 起動 IPC は mode、保存済み `characterId`、provider と runtime options だけを受け取る。Editor draft、theme、user instruction は渡さない。
- provider は必須入力として空白を除去し、fallback しない catalog ID の完全一致と Settings の enabled 状態を workspace mutation 前に検証する。provider 確定、workspace 準備、Session 永続化は Settings / catalog 更新と同じ provider operation coordinator で直列化する。
- Editor に未保存変更がある場合は起動を拒否し、先に保存を求める。
- Session 準備処理は `character.md` / `character-notes.md` を書き直さない。保存済み files と catalog metadata を起点にする。
- 保存済み `character.md` が hard contract を外れて metadata を parse できない場合、Editor draft は catalog metadata を維持して未保存扱いにせず、authoring session から修復できるようにする。

### Fixed Project policy

- app 管理の `withmate-character-authoring` Skill を Codex / Copilot の provider-specific skill root へコピーする。
- Skill は局所修正向けの targeted update と、新規作成・全面改稿・事実追加向けの full authoring を区別する。
- 両 mode で format、8,000 文字上限、output boundary、依頼箇所の targeted review を確認する。
- source 調査は full authoring で行う。ただし、ユーザーが `検索不要` と指定した場合は行わない。
- 全 rubric と 7 ケースの relationship smoke test は full authoring で行う。targeted update では依頼箇所と直接影響する behavior だけを確認する。
- public `description` は会話の挨拶や支援説明ではなく profile bio とし、authoring target は通常 1〜3 文、160 文字以下とする。
- 関係性は具体的な反応と境界を定義し、明示された根拠がない恋愛、独占、依存を既定値にしない。
- permanent Character outputs は `character.md` と `character-notes.md` に限定する。Project の source report、review checklist、manifest、pack directory、Zip は Character root に生成しない。
- optional な `character-notes.md` が存在しない場合は、Session 起動処理では作成せず、Skill が必要な authoring で同梱 template から作成する。

### Authoring snapshot lifecycle

- ADR 009 の stable owner ID は snapshot の有無と独立して維持する。
- 各 authoring turn は canonical definition から runtime snapshot を再生成する。
- valid から invalid または必須 `character.md` の欠落へ変わった場合は、古い snapshot と provider thread ID の破棄を composer / provider validation より前に永続化し、process-local thread cache も破棄する。
- 修復 turn は途中の入力エラー後も旧 Character instruction を含む provider continuation を resume しない。

## Alternatives

### 128 KiB を維持する

runtime prompt の簡潔さと Project の品質基準を機械的に守れないため採用しない。

### Authoring session だけ 8,000 文字にする

Editor、import、direct file edit、runtime snapshot で異なる contract になるため採用しない。

### ChatGPT Project の全 artifact を Character root に複製する

Character storage の正本と補助生成物が混在し、永続化と削除の責務が広がるため採用しない。

### 起動 dialog に改善指示欄を追加する

通常 Session composer と入力経路が二重になり、現行 UI を変える便益もないため採用しない。

### 小さな修正にも full authoring を要求する

局所的な文言修正まで source 調査と全評価を要求すると、品質上の便益に対して実行時間と token 消費が過大になるため採用しない。

## Consequences

- 既存の 8,000 文字超 `character.md` は、起動時に再保存せず authoring session から上限内へ戻せる。
- 起動時の file 改行や末尾改行は保持され、未保存 draft が canonical files を上書きしない。
- 小さな修正は targeted update で軽く扱い、広い改稿と事実変更には full authoring の品質確認を維持する。
- 160 文字の description、source 調査、relationship rubric は authoring quality target であり、storage hard validation にはしない。
- authoring 中に定義が一時的に invalid になった場合は、provider thread の会話継続性より canonical definition との整合を優先する。
