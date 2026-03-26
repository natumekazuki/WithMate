# Plan

- task: Session Window の白画面を修正する
- owner: Codex
- status: in_progress

## Goal

- 現在発生している Session Window の white screen を再現し、原因を特定して修正する

## Scope

- Session Window 起動経路
- Main / preload / renderer の起動時例外
- 必要なら session memory 追加差分

## Out Of Scope

- 無関係な Memory 機能追加
- 既存の backlog 整理以外の docs 大幅改稿

## Steps

1. 再現して例外箇所を特定する
2. 原因を修正する
3. build と relevant test で再確認する
