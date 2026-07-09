# Issue 3 Memory Plan

- 作成日: 2026-03-12
- 対象 Issue: `#3 LangGraphを使ってMemoryの永続化と共有`
- 参照: `https://github.com/natumekazuki/WithMate/issues/3`

## Goal

Issue #3 を、現在の `api-only Character Stream` 方針と接続した Memory 設計として整理する。
特に、`Character Memory` `Session Memory` `Monologue Context` の責務分離、永続化単位、抽出フロー、LangGraph 導入範囲を明確にする。

## Current Findings

- Issue #3 は `キャラごとのMemoryを永続化` と `セッション単位でもMemoryを永続化し、そこから独り言機能で使うコンテキストを抽出する` を求めている
- `docs/design/monologue-provider-policy.md` では、独り言コスト最適化のために Memory を前提化した
- したがって `#3` は単なる保存機能ではなく、独り言機能の入力圧縮レイヤーも担う
- 現時点では LangGraph の具体 API を repo 内で未整理なので、実装前に公式仕様確認が必要

## Task List

- [x] Memory の責務を `Character / Session / Monologue Context` に分離して定義する
- [x] 永続化単位、更新契機、読み出し契機を整理する
- [x] 独り言生成へ渡す抽出フローを定義する
- [x] LangGraph をどこまで採用するか、最小導入範囲を決める
- [x] 既存設計 docs への影響を整理する
- [x] 実装前に必要な外部仕様確認項目を列挙する

## Affected Files

- `docs/design/monologue-provider-policy.md`
- `docs/design/product-direction.md`
- `docs/design/session-persistence.md` (new or update)
- `docs/design/memory-architecture.md` (new)
- `docs/plans/20260312-issue-3-memory.md`

## Design Check

- 新しい Design Doc が必要
- 理由: Memory の種類、保存先、抽出責務、LangGraph の適用範囲を後続実装の基準として固定したいため
- 追加対象:
  - `docs/design/memory-architecture.md`
  - `docs/design/session-persistence.md`（未作成なら新規）

## Risks

- LangGraph の API や永続化機構を確認せずに設計すると、後で全面修正になりやすい
- Memory を肥大化させると、独り言コスト削減どころか逆に入力負荷が増える
- Character Memory と Session Memory の責務が曖昧だと、キャラの一貫性と作業継続性の両方が崩れる
- 永続化先を早めに決めないと、`#1` の API 側設計と `session persistence` 設計に波及する

## Proposed Direction

- `Character Memory`
  - キャラ固有の継続特性
  - セッションをまたいで共有
- `Session Memory`
  - その作業セッション固有の目的、決定事項、未解決論点
  - セッション単位で保存
- `Monologue Context`
  - 上記から独り言生成専用に圧縮した短い入力
  - 永続化対象ではなく、派生データとして扱う第一候補
- LangGraph はまず `Memory orchestration` の境界でのみ採用し、本体の UI 状態管理へ広げない

## External Verification Needed

- LangGraph の memory / state / persistence の公式設計
- Electron / Node 環境での採用パターン
- 永続化 backend の候補と最小構成
- 長期 Memory と短期 Memory の分離方法

## Notes / Logs

- `#1` の設計で、独り言は API かつ Memory 入力前提に固定済み
- そのため `#3` は優先度が高く、少なくとも設計レベルでは先に固める価値がある
- LangGraph 公式 docs を確認し、`checkpointer = thread-level persistence`、`Store = cross-thread memory` の対応を採用した
- WithMate ではこれを `Session Memory = checkpointer`、`Character Memory = Store` に対応づける
- `Monologue Context` は永続化対象ではなく、独り言生成用に都度組み立てる派生入力として扱う
- 設計 docs として `docs/design/memory-architecture.md` と `docs/design/session-persistence.md` を追加した
- TTL は実運用で調整する前提で、MVP ではまず責務分離を優先する
