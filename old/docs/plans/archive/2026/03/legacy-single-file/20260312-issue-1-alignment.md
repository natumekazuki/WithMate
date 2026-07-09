# Issue 1 Alignment Plan

- 作成日: 2026-03-12
- 対象 Issue: `#1 定期実行はサブスクリプションだと規約違反の可能性がある`
- 参照: `https://github.com/natumekazuki/WithMate/issues/1`

## Goal

Issue #1 の方針を、現在の WithMate 設計へ矛盾なく取り込む。
具体的には、`CLI ログイン前提の coding agent 本体` と、`API キー前提の Character Stream / 独り言機能` の責務境界を整理し、MVP の表示条件と認証要件を明文化する。

## Current Findings

- 現在の方針では、coding agent 本体は `Codex CLI` ログイン前提で、API キーを使わない想定になっている
- Issue #1 は、独り言機能だけは API キーを使い、`GPT-5 mini` 固定で提供する案を出している
- つまり `本体は CLI auth`、`独り言は API auth` の二系統構成にするかどうかが論点
- `Character Stream` は現状 UI 上の主価値として残しているが、Issue #1 の方針を入れると「API キー未登録時は非表示または縮退表示」にする必要がある

## Task List

- [x] Issue #1 の要求を現行設計に照らして論点分解する
- [x] coding agent 本体と Character Stream の認証・モデル・実行責務を分離して設計する
- [x] `API キー未登録時の Character Stream` の挙動を決める
- [x] `GPT-5 mini` 固定の扱いと設定露出範囲を決める
- [x] 影響を受ける設計ドキュメントを更新する
- [x] 実装着手前の合意ポイントを整理する

## Affected Files

- `docs/design/product-direction.md`
- `docs/design/agent-event-ui.md`
- `docs/design/session-launch-ui.md`
- `docs/design/character-chat-ui.md`
- `docs/design/monologue-provider-policy.md` (new)
- `docs/plans/20260312-issue-1-alignment.md`

## Design Check

- 新しい Design Doc が必要
- 理由: 認証方式、表示条件、モデル固定、UI の縮退挙動を後続実装の基準として固定したいため
- 追加対象: `docs/design/monologue-provider-policy.md`

## Risks

- `APIキーは使わない` という既存の方針と正面衝突しやすい
- Character Stream をこのアプリの固有価値としているため、API キー未登録時の UX が弱くなりうる
- coding agent 本体と独り言機能で認証方式が分かれると、ユーザーの理解コストが上がる
- OpenAI 側の利用条件やモデル availability が変わる可能性があるため、実装前提を固定しすぎると後で手戻りが出る

## Proposed Direction

- coding agent 本体: これまでどおり `Codex CLI` ログイン前提
- Character Stream / 独り言: OpenAI API キー前提の別機能として分離
- API キー未登録時: Character Stream は非表示ではなく、`利用条件を示したプレースホルダ表示` を第一候補とする
- モデル: MVP では `gpt-5-mini` 固定を前提にする

## Notes / Logs

- Issue #1 本文: `独り言機能はAPIキーを使用する / GPT-5miniなら安いので、モデル固定でAPIキーが登録されてる場合のみ独り言コンポーネントを表示`
- この issue は UI だけでなく、認証境界・設定管理・今後の料金説明にも影響する
- 結論として、coding agent 本体は `Codex CLI / SDK` のまま維持し、独り言は OpenAI API 側へ分離する
- 独り言の MVP モデルは `gpt-5-mini` 固定とする
- API キー未設定時は Character Stream を縮退表示する方針を第一候補とする
- Memory Issue `#3` は独り言の継続性だけでなく、入力圧縮によるコスト最適化基盤として扱う
- 仕様は `docs/design/monologue-provider-policy.md` に新規作成し、既存 docs に参照を追加した
