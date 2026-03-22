# Plan

## Goal

- Session Window を `1920x1080` フル表示基準で再配置し、会話・実況・turn 詳細の面を分離した layout target を定義する
- 次の実装で迷わないよう、column 構成、各面の責務、responsive fallback を先に固定する

## Scope

- Session Window の layout redesign 設計
- `docs/design/session-window-layout-redesign.md` の作成
- 実装時に影響する主要 UI 領域と検証観点の整理

## Out of Scope

- 実コード変更
- Home / Character Editor / Diff の layout redesign
- provider adapter や data schema の変更

## Task List

- [x] 現行 Session Window の主要面と課題を棚卸しする
- [x] `1920x1080` 基準の target layout を設計する
- [x] 実装時の主要変更点と検証観点を plan に落とす

## Affected Files

- `docs/design/session-window-layout-redesign.md`
- `docs/design/desktop-ui.md`
- `docs/manual-test-checklist.md`
- `src/App.tsx`
- `src/styles.css`

## Risks

- 右 rail を増やすと message list の横幅が不足し、本文可読性を逆に落とす可能性がある
- `Turn Inspector` と inline artifact detail の責務が重複すると UI が二重化する
- `1920x1080` 基準を強くしすぎると narrow width fallback の設計が弱くなる

## Design Doc Check

- 状態: 新規設計 doc を作成
- 対象: `docs/design/session-window-layout-redesign.md`
- メモ: `docs/design/desktop-ui.md` は実装タイミングで target layout を反映する
