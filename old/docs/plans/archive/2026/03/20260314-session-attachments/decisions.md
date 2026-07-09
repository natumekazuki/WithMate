# Decisions

## Summary

- picker を主導線、`@path` を補助導線として併存させる
- 通常ファイル/フォルダは prompt 参照として渡し、画像だけ SDK structured input を使う

## Decision Log

### 0001

- 日時: 2026-03-14 23:35
- 論点: 添付 UX を SDK の仕様とどう両立するか
- 判断: picker と `@path` を同じ attachment に正規化し、file/folder/image を app 側で厳密判定する
- 理由: SDK は画像以外の添付 API を持たないため、WithMate 側で構文と picker を吸収するのが最も安定する
- 影響範囲: `src/App.tsx`, `src-electron/main.ts`, `src-electron/codex-adapter.ts`, `docs/design/*`
