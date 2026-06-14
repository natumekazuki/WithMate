# V5 Character Transition

- 作成日: 2026-06-12
- 対象: V4 SingleMate から V5 Character-first へ移行するための方針正本

## Goal

V5 の中核変更を、SingleMate の延命ではなく Character catalog / Character Definition への回帰として固定する。

この文書は、V4 で追加投資する範囲を止め、V5 移行時に Codex や作業者が旧 SingleMate docs に引っ張られないようにするための正本である。

## Position

- V4 current 実装の正本は引き続き `docs/design/single-mate-architecture.md` と `docs/design/provider-instruction-sync.md` とする。
- この文書は V5 移行方針の正本である。V5 Character Core merge 後は、Character catalog / snapshot / prompt boundary について `docs/design/character-definition-format.md`、`docs/design/character-storage.md`、`docs/design/v5-character-core-release-gate.md` を current source of truth として優先する。
- V5 詳細設計、DB schema、UI、migration 手順は、この文書で決めすぎない。
- V5 親 Issue / Notion / 設計タスクを作るときは、この文書を入口にする。

## Source Notes

この文書は 2026-06-12 に作成した V5 Character 化前タスクリストを repo 内向けに整理したもの。

取り込んだ観点:

- V4 でやること / やらないことの境界
- V5 Character 化の親 Issue に入れるべき方針
- Codex usage-limit error classification の扱い
- Codex diagnostic stream log cleanup の扱い
- YacchoGPT から参考にする Character Definition 設計観点

repo 外の作業ディレクトリや個人環境 path は、この文書の正本情報として扱わない。

## V4 Exit Criteria

V4 でやることは、V5 Character 化の邪魔になるものを止めることと、V5 でも使う provider runtime の明確な不具合修正に絞る。

| Priority | Task | Status | Reason |
| --- | --- | --- | --- |
| P0 | V5 Character 化の親 Issue / 方針メモを固定 | next | SingleMate 周辺への追加投資を止めるため |
| P0 | YacchoGPT から参考にする Character Definition 設計観点を残す | in this doc | V5 `character.md` の方向性を固定するため |
| P1 | Codex usage-limit error classification | done | provider runtime の低レイヤー修正で、V5 でも使うため |
| P1 | Codex diagnostic stream log cleanup | done | 通常運用ログを stream event で汚さないため |
| P2 | V4 deferred scope の明文化 | in this doc | V5 で捨てる可能性が高いものに追加投資しないため |

関連:

- `docs/plans/20260612-codex-usage-limit-error.md`
- `docs/plans/20260612-codex-diagnostic-log-cleanup.md`

## V4 Deferred Scope

以下は V4 では実装しない。V5 Character 化の完了後、必要なら個別 Issue として扱う。

| Deferred item | Reason | Resume timing |
| --- | --- | --- |
| Memory access / Skill 化 | Character 化の中核ではなく、Memory 再設計に引っ張られる | V5 Character 移行後 |
| Auxiliary preset | Character snapshot / New Session 設計と密接に絡む | V5 Character 移行後 |
| `.continue` | session-local runtime files の設計が必要 | V5 Character 移行後 |
| `session-memo.md` | `.continue` と同じく session-local runtime files に統合すべき | V5 Character 移行後 |
| Browser Preview | artifact/context 基盤が大きく、Character 化の範囲を超える | V5 安定後 |
| Multi-agent | Character 化とは別の実行モデル変更 | V5 後半 |
| 放牧 | background / scheduled execution / WSL2 が絡む | V5 後半 |
| provider instruction sync 強化 | V5 では Character 注入の主経路にしない | 原則不要 |
| V4 Mate Profile / Growth 改善 | SingleMate 延命になる | 原則不要 |
| V4 Mate から V5 Character への丁寧な自動 migration | 初期 V5 の設計を重くする | V5 import/export 設計時 |

V4 で例外的に扱ってよいもの:

- provider adapter の明確な bug fix
- user-facing なクラッシュ / フリーズ修正
- data loss 防止
- V5 移行を妨げない log cleanup
- package / build / test の明確な破損修正

## V5 Core Decision

V5 の中核変更は、SingleMate から Character catalog / Character Definition へ戻すことである。

V5 への移行条件は、複数 Character へ戻せていることとする。これは型や DB だけの複数対応ではなく、少なくとも次を満たすことを意味する。

- 複数 Character を保存できる
- UI 上で複数 Character の存在を確認できる
- Home から Character 一覧と作成導線へ到達できる
- Character の作成・編集は独立した Character Editor Window で行える
- session / companion 起動時に Character を選択できる
- session 開始時点の Character snapshot が保存される
- 既存 session は catalog 変更の影響を受けない

V5 初期 scope:

- 複数 Character を作成・選択できる
- Home に Character catalog 一覧と `Create Character` を置く
- 独立した Character Editor Window で最低限の Character 編集画面を使える
- `character.md` を手動貼り付け / import / 保存できる
- `character.md` を runtime 定義の正本にする
- `character.md` を毎 turn prompt へ注入する
- session 開始時に Character snapshot を固定する
- `character-notes.md` は runtime 常設 prompt に入れない
- provider instruction sync は Character 注入の主経路にしない

V5 初期 non-goals:

- Memory 再設計
- Auxiliary preset
- Browser Preview
- Multi-agent
- 放牧
- V4 Mate Profile / Growth の延命
- V4 Mate Profile から V5 Character への丁寧な自動 migration
- YacchoGPT プロンプト本文の複製や、特定キャラクターへの依存
- Character 定義の自動生成
- GPT-5.5 Pro 等を使う Character authoring workflow の WithMate 内組み込み
- Character Editor の詳細 authoring UX
- V3 Character Editor / Character Update Workspace の復活
- Character validator / Knowledge retrieval

V5 Core の最低限編集画面は、Home 起点の Character Editor Window で、作成済みの `character.md` を WithMate に登録、修正、保存するための raw editor と metadata editor に限る。Settings Window には Character raw editor を置かない。section 単位の詳細 Editor、validator、revision / diff / rollback、Character Update Workspace、Character 定義自動生成は Core 完了後の個別 Issue で扱う。

## Phase 4 Preconditions From Pre-V5 Cleanup

`docs/plans/20260612-pre-v5-delete-feature/plan.md` の Phase 3 完了後、V5 Character-first 作業へ入る前提は次の通り。

- Session / Project Memory の background extraction、Project Memory prompt injection、promotion runtime は削除済み。既存 DB の storage / read / delete / diagnostics 境界だけを legacy compatibility として保持する。
- Mate storage / Mate state / Mate setup UI は Phase 3 では削除しない。Phase 4 で Home と session 起動を Mate 未作成 gate から外し、V5 Character 未実装時の neutral state と minimal app state へ縮小する。
- MateTalk runtime / window / chat mode は V5 preview 前に current runtime から削除する。Character Chat が必要な場合は、V5 Character catalog から選択した Character を使う別 Issue として再設計する。
- 既存 DB table drop や V4 Mate Profile から V5 Character への丁寧な自動 migration は Phase 4 の前提にしない。

## Character Definition Direction

V5 の Character Definition は、単なる口調設定ではなく、実行可能な人格仕様として扱う。

YacchoGPT から参考にするのは、特定キャラクターの本文ではなく、Character Definition の責務分離と設計密度である。

V5 の `character.md` には、最低限次の情報を表現できるようにする。

- identity
- non-negotiable principles
- public premise
- private / internal truth
- disclosure policy
- personality core
- relationship boundary
- voice rules
- signature phrases with usage conditions
- coding agent behavior
- unknown handling
- output format
- examples

一方、`character-notes.md` は調査メモ、出典、採用理由、改稿履歴、未確定事項を置く補助ファイルであり、毎 turn prompt には常設しない。

## Recommended `character.md` Sections

```md
---
schema: withmate-character-v5
name: ""
description: ""
---

# Character Runtime Definition

## Identity

## Non-negotiable Principles

## Public Premise

## Private / Internal Truth

## Disclosure Policy

## Personality Core

## Response Texture

## Relationship With User

## Voice Rules

## Signature Phrases

## Coding Agent Behavior

## Knowledge Policy

## Output Format

## Examples

## Runtime Notes
```

Section notes:

- `Non-negotiable Principles` は 3 から 7 項目程度に絞る。
- private / internal truth には、直接開示してはいけない policy を同じ section 内に置く。
- Voice rules は単語リストではなく、使う場面、使わない場面、使いすぎ防止を持つ。
- Signature phrases は frequency と avoid 条件を必須にする。
- Coding agent behavior は repository instruction、ユーザー指示、実行結果、diff、test result の正確性を優先する。
- Unknown handling では、記憶、source facts、repo facts、test results を捏造しないことを明記する。

## Recommended `character-notes.md` Sections

```md
# Character Notes

## Evidence / Sources

## Interpretation Notes

## Rejected Ideas

## Revision Notes

## Future Improvements

## Long Knowledge
```

`character-notes.md` は runtime prompt の主要入力ではない。Character update workspace、将来の Knowledge pack、validator fixture などで必要時だけ参照する。

## Runtime Injection Boundary

毎 turn prompt に入れる:

- `character.md` 相当の session snapshot
- app 共通 guard
- session 固定の provider / model / approval / sandbox 情報
- user input

毎 turn prompt に入れない:

- `character-notes.md`
- 長い出典一覧
- 改稿履歴
- 採用しなかった解釈
- validator fixture 全文
- long knowledge 全文
- raw memory / growth history

V5 prompt の優先順位:

1. system / safety / tool rules
2. repository instruction / user instruction
3. coding correctness
4. Character Definition
5. signature phrase / decoration

ただしユーザー体験上は、正確な内容を Character の声で説明することを目指す。

## Parent Issue Draft

V5 親 Issue には、次の短縮版を入れる。

```md
# V5: Character化

## 決定

V5の中核変更は、SingleMateからCharacter catalog / Character Definitionへ戻すこと。

## Scope

- 複数Characterを作成・選択できる
- `character.md` をruntime定義の正本にする
- `character.md` を毎turn promptへ注入する
- session開始時にcharacter snapshotを固定する
- `character-notes.md` はruntime常設promptに入れない
- provider instruction syncはCharacter注入の主経路にしない

## Character Definitionで参考にする方針

YacchoGPTを参考に、V5のCharacter Definitionは単なる口調設定ではなく、実行可能な人格仕様として扱う。

V5の`character.md`には、絶対原則、公開前提、内部前提、開示境界、口調規則、口癖の使用条件、coding agentとしての振る舞い、不明情報を捏造しないルール、出力形式、代表例を表現できるようにする。

ただし、V5初期ではYacchoGPT相当の詳細Editorやvalidator実装は中核移行後の後続とする。

## Non-goals

- Memory再設計
- Auxiliary preset
- Browser Preview
- Multi-agent
- 放牧
- V4 Mate Profile / Growthの延命
- V4 Mate ProfileからV5 Characterへの丁寧な自動migration
- YacchoGPTプロンプト本文の複製や、特定キャラクターへの依存
```

## Migration Work Order

1. V5 親 Issue / Notion を作り、この文書への参照を残す。
2. V4 deferred scope を Issue コメントまたは Notion メモに残す。
3. `docs/design/character-definition-format.md` を V5 Core の `character.md` / `character-notes.md` format に縮小更新する。
4. `docs/design/character-storage.md` を SQLite metadata + file body + session snapshot の境界に合わせて更新する。
5. `docs/design/character-update-workspace.md` は Core の正本に戻さず、V5 Core 後の詳細 Editor / update workspace 候補として扱う。
6. V5 Character storage / prompt composer / session snapshot の設計を必要に応じて別文書で切る。
7. Memory / Auxiliary / Browser Preview / Multi-agent は Character 化の初期実装が安定するまで扱わない。

## Legacy Character Docs Handling

Phase 4 完了時点では、旧 Character docs は実装仕様の正本にしない。

| Doc | Phase 4 handling |
| --- | --- |
| `docs/design/character-definition-format.md` | Phase 4 では future candidate として保持した。V5 Core Branch 2 以降は `character.md` / `character-notes.md` format 正本として採用する。 |
| `docs/design/character-storage.md` | Phase 4 では future candidate として保持した。V5 Core Branch 3 以降は Character catalog / storage / snapshot 境界の正本として採用する。 |
| `docs/design/character-update-workspace.md` | Character update workspace の future candidate として保持する。V5 初期の session 起動 gate 解除には接続しない。 |

Phase 4 の実装上の正本は、Home / session 起動を Mate 未作成 gate から外し、V5 Character 未実装時は neutral character snapshot で起動できるようにすることに限る。

V5 Core 開始後は、次の扱いに切り替える。

| Doc | V5 Core handling |
| --- | --- |
| `docs/design/v5-character-transition.md` | V5 Core scope / non-goals / completion criteria の入口。 |
| `docs/design/character-definition-format.md` | V5 Core 用に縮小更新して、`character.md` runtime definition と `character-notes.md` non-runtime notes の format 正本にする。 |
| `docs/design/character-storage.md` | V5 Core 用に更新して、catalog metadata、file body、default selection、session snapshot の storage 正本にする。 |
| `docs/design/character-update-workspace.md` | V5 Core では正本にしない。詳細 Editor / update workspace の deferred candidate として保持する。 |

## V5 Core Branch Plan

V5 Core の 1 本目は docs-only で、この文書と関連 docs の source of truth を固定する。2 本目以降の branch 構成と作業内容は `docs/plans/20260613-v5-character-core-branches.md` を参照する。

## Related Docs

- `docs/design/product-direction.md`
- `docs/design/single-mate-architecture.md`
- `docs/design/provider-instruction-sync.md`
- `docs/design/character-definition-format.md`
- `docs/design/character-storage.md`
- `docs/design/character-update-workspace.md`
- `docs/plans/20260612-codex-usage-limit-error.md`
- `docs/plans/20260612-codex-diagnostic-log-cleanup.md`
