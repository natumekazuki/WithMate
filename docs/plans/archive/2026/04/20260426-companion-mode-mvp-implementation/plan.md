# Companion Mode MVP 実装 Plan

- 作成日: 2026-04-26
- 種別: repo plan
- 対象: Companion Mode の MVP 実装
- 正本仕様: `docs/design/companion-mode.md`

## 目的

Companion Mode を Agent Mode と分離した作業モードとして追加する。
最初の実装単位では、Home の起動導線から Git repo root を検証し、専用 DB table に CompanionGroup / CompanionSession を作成できる状態までを完了させる。

## スコープ

### 実装する

- Home の launch dialog に `Agent / Companion` の mode 選択を追加する
- Companion 起動時に Git repo root eligibility を Main Process 側で検証する
- Companion 用の型、IPC、preload API を追加する
- Companion 専用 DB table の初期 schema を追加する
- CompanionGroup / CompanionSession の作成と一覧取得の service / storage を追加する
- CompanionSession 作成時に repo root、focus path、target branch、provider / model / approval / sandbox / character snapshot を保存する
- 最小限の Home 表示として active CompanionSession を確認できる一覧を追加する

### 今回は実装しない

- snapshot commit / internal ref 作成
- shadow worktree 作成
- provider を shadow worktree で実行する処理
- Companion Review Window
- selected files merge / discard
- sibling check
- hunk 単位 merge
- MemoryGeneration 連携

## チェックポイント

1. 既存構成確認
   - `src` / `src-electron` の session 起動、IPC、storage、window lifecycle を確認する
   - `docs/design/companion-mode.md` と `docs/design/database-schema.md` の更新要否を確認する

2. Companion domain / storage
   - Companion の共有型を追加する
   - `companion_groups` / `companion_sessions` の schema と CRUD を実装する
   - storage 単体テストを追加する

3. Git eligibility / lifecycle service
   - Git root、HEAD、branch、bare / detached state を検証する helper を追加する
   - CompanionSession 作成 service を追加する
   - eligibility 単体テストを追加する

4. IPC / preload / renderer API
   - Companion 作成・一覧取得の IPC channel を追加する
   - `WithMateWindowApi` と preload 実装に Companion API を追加する
   - IPC 登録テストを更新する

5. Home 起動導線
   - launch dialog に mode toggle を追加する
   - Companion mode では Git eligibility の失敗を user-facing error として表示する
   - active CompanionSession の最小一覧を Home に表示する
   - projection / state 単体テストを追加する

6. ドキュメントと検証
   - `docs/design/database-schema.md` を current schema に合わせて更新する
   - 必要に応じて `.ai_context/` の影響を確認する
   - `npm test` と `npm run typecheck` を実行する

## 完了条件

- Home から Companion mode を選んで Git repo 配下の workspace で CompanionSession を作成できる
- Git repo でない directory では CompanionSession 作成が拒否される
- CompanionSession は既存 `sessions` table ではなく専用 table に保存される
- Home で active CompanionSession の存在を確認できる
- 追加・更新した設計書とテストが実装内容と一致している
