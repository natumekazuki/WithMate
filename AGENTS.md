# WithMate Agent Guide

## Language

- ユーザーへの回答、生成ドキュメント、コミットメッセージは日本語で書く。
- repo 内ファイルは repo root 相対パスで示す。
- 不明な仕様、API、依存関係は断定しない。実装、設計文書、既存テストを確認してから答える。

## Project Structure

WithMate は Electron + React + TypeScript のデスクトップアプリである。

- `src/`: renderer 側の React UI、状態管理、window API 型。
- `src-electron/`: main process、preload、IPC、永続化、provider 連携。
- `scripts/`: 生成、migration、検証用スクリプト。
- `scripts/tests/`: Node test runner 用の `*.test.ts` / `*.test.tsx`。
- `docs/design/`: 現行設計の正本。
- `docs/plans/`: 複数セッションや高リスク作業の計画。
- `build/`: packaging 入力。icon は `build/icon.svg` を source of truth とする。

## Coding Style

- TypeScript は `strict` 前提で扱う。
- ES modules、`NodeNext`、React JSX runtime の既存構成に合わせる。
- 既存コードに合わせ、2 spaces、double quotes、末尾セミコロンを基本にする。
- ファイル名は kebab-case を優先し、React component は既存に合わせて PascalCase を使う。
- 共通処理は既存 helper と service 層へ寄せる。
- 無関係な整形、rename、refactor を混ぜない。
- 生成物やドキュメントに個人環境の絶対 path を残さない。

## UI Architecture

チャット体験はアプリの主要 UI であり、実装の分岐を増やさない。

- チャット UI の layout / message list / composer / right pane shell は 1 系統を正本にする。
- 会話機能ごとの差分は mode、capability、service adapter で切り替える。
- 新しい会話機能を追加するときも、独自 chat layout を作らない。
- 機能ごとに不要な操作は非表示にしてよいが、構造と操作感は既存の Session UI に揃える。
- 出す情報がない right pane を説明文で埋めない。

## UI Design

- 文字色と背景色が近すぎて読めない組み合わせを作らない。
- theme token や既存 CSS variable を優先し、場当たり的な色指定を増やさない。
- 新しい背景色、surface 色、badge 色、button 色を追加する場合は、その上に乗る text / icon / border の contrast も同時に確認する。
- disabled、muted、placeholder、secondary text は薄くしすぎない。背景と同化する場合は色ではなく opacity、weight、spacing、label の整理で調整する。
- hover、selected、active、focus、error、warning、success の各 state で文字が背景に埋もれないことを確認する。

## Data And Privacy

- 永続化データの正本と投影結果を混同しない。
- Markdown や provider instruction が generated projection の場合、手編集を正本にしない。
- ユーザーが削除または忘却した情報は、UI 表示だけでなく projection や provider instruction に残らないように扱う。
- secret、token、個人環境 path を commit しない。

## Commands

- `npm install`: 依存関係を導入する。
- `npm run dev`: Vite renderer dev server を起動する。
- `npm run electron:dev`: Electron main を build して開発起動する。
- `npm run build`: renderer と Electron main を本番向けに build する。
- `npm run typecheck`: renderer と Electron の TypeScript 型検査を実行する。
- `npm test`: `scripts/tests/*.test.ts(x)` を `tsx --test` で実行する。
- `npm run dist:win`: Windows installer を作成する。

## Testing

- 変更種別に合う最小の targeted test を優先する。
- 永続化、migration、IPC、provider adapter を変更した場合は、関連 test に加えて TypeScript 型検査を実行する。
- UI 変更では、可能なら state / projection / component test を追加または更新する。
- 全体検証が既存の unrelated failure で落ちる場合は、関係する failure と unrelated failure を切り分けて報告する。
- 検証できない場合は、理由、代替確認、残リスクを明記する。

## Git

- commit は 1 つの論理変更単位を基本にする。
- commit message は conventional commits を使う。
- commit 前に `git status --short` を確認し、ユーザー由来の無関係変更を混ぜない。
- `AGENTS.md` はユーザーが明示するまで commit しない。
- push はユーザーが明示した場合だけ実行する。
