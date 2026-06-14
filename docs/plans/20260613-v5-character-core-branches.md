# V5 Character Core Branch Plan

- 作成日: 2026-06-13
- 対象: V5 Character Core の 2 本目以降の branch 構成
- 前提: 1 本目の docs-only branch で V5 Core scope / non-goals / source of truth を固定する

## Goal

V5 Core の移行条件である「複数 Character へ戻せていること」を、review 可能な branch 単位へ分割する。

Core では、複数 Character catalog、最低限の Settings 編集画面、Home / session / companion 起動時の Character selection、session snapshot、prompt injection boundary までを扱う。

Core に Character 定義自動生成、詳細 Editor、Character Update Workspace、Memory / Growth / MateTalk 再設計は含めない。

## Branches

| Order | Branch | Scope | Depends on |
| --- | --- | --- | --- |
| 2 | `feat/v5-character-definition-core` | `character.md` / `character-notes.md` の V5 Core format、parser、最低限 validation、fixture tests を追加する。 | docs contract |
| 3 | `feat/v5-character-storage-catalog` | 複数 Character catalog / storage / service / IPC / preload API を追加する。SQLite metadata、file body、default character、archive、snapshot 用 domain model を扱う。 | 2 |
| 4 | `feat/v5-character-settings-editor` | Settings に `Characters` section を追加し、Character 一覧、新規作成、metadata 編集、raw `character.md` editor、import / replace、default、archive を実装する。 | 3 |
| 5 | `feat/v5-character-launch-selection` | Home / New Session / Companion 起動で Character selector を追加し、選択 Character を session / companion 作成 payload へ渡す。0 件時は neutral fallback を維持する。 | 3 |
| 6 | `feat/v5-character-runtime-snapshot` | session / companion 作成時に Character snapshot を保存し、runtime prompt に `character.md` snapshot を注入する。catalog 現在値ではなく saved snapshot を使う。 | 3, 5 |
| 7 | `test/v5-character-core-release-gate` | automated checks、manual checklist、release note、known risks を固定し、V5 Core 完了判定を行う。 | 2-6 |

## Branch 2: Character Definition Core

目的:

- V5 Core の `character.md` 最小 format を実装可能な粒度で固定する。
- `character-notes.md` を runtime 常設 prompt に入れない補助ファイルとして固定する。
- raw editor / import が使う最低限 validation を用意する。

主な作業:

- `docs/design/character-definition-format.md` を V5 Core 用に縮小更新する。
- `src/character/` 配下に definition 型、parser、validation helper を追加する。
- frontmatter の `schema: withmate-character-v5` と `name`、body の空判定、size limit、null byte、path safety を扱う。
- `scripts/tests/character-definition-format.test.ts` または validation test を追加する。

含めないもの:

- Character 定義自動生成
- LLM による添削
- 人格品質 validator
- Knowledge retrieval

## Branch 3: Character Storage Catalog

目的:

- SingleMate の `current` 固定ではなく、複数 Character を保存、列挙、取得、更新できる storage boundary を作る。
- metadata、file body、session snapshot の責務を分離する。

主な作業:

- `docs/design/character-storage.md` を V5 Core storage 正本へ更新する。
- `src/character/` に renderer / shared 型を追加する。
- `src-electron/character-storage.ts` と `src-electron/character-service.ts` を追加する。
- `src/withmate-ipc-channels.ts`、`src/withmate-window-api.ts`、`src-electron/preload-api.ts`、`src-electron/main-ipc-registration.ts` を更新する。
- list / get / create / update metadata / update definition / archive / set default / resolve launch character を扱う。

検証:

```bash
npm run typecheck
node --import tsx --test scripts/tests/character-storage.test.ts
node --import tsx --test scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts scripts/tests/renderer-withmate-api.test.ts
```

## Branch 4: Settings Character Minimum Editor

目的:

- ユーザーが手動で用意した `character.md` を WithMate に登録、編集、保存できる最低限 UI を Settings に追加する。

主な作業:

- `src/settings/` に Characters section を追加する。
- Character list、detail、name、description、icon、theme、raw `character.md` textarea、import / replace、save / cancel、default、archive を実装する。
- validation error を raw editor 向けに表示する。

含めないもの:

- section 単位の詳細 Editor
- revision / diff / rollback
- validator UI
- Character Update Workspace
- Character 定義自動生成

検証:

```bash
npm run typecheck
node --import tsx --test scripts/tests/settings-ui.test.ts
node --import tsx --test scripts/tests/character-storage.test.ts
node --import tsx --test scripts/tests/main-ipc-registration.test.ts scripts/tests/preload-api.test.ts scripts/tests/renderer-withmate-api.test.ts
```

## Branch 5: Home / Session Character Selection

目的:

- New Session と Companion 起動で Character を選択できるようにする。
- Character 未作成時の neutral fallback と Mate 未作成 gate 非復活を維持する。

主な作業:

- `src/home/` の launch state / projection / handlers / dialog に Character selector を追加する。
- default character を初期選択する。
- Character name / icon / theme preview を表示する。
- session / companion 作成 payload に選択 Character を渡す。
- summary で選択 Character を判別できるようにする。

検証:

```bash
npm run typecheck
node --import tsx --test scripts/tests/home-launch-state.test.ts scripts/tests/home-launch-projection.test.ts scripts/tests/home-launch-actions.test.ts scripts/tests/home-components.test.tsx
```

## Branch 6: Runtime Snapshot / Prompt Injection

目的:

- session / companion 開始時点の Character snapshot を固定し、runtime prompt に `character.md` 相当の snapshot だけを注入する。

主な作業:

- `src/session-state.ts` / `src/app-state.ts` に CharacterRuntimeSnapshot を接続する。
- `src-electron/session-persistence-service.ts` と companion persistence に snapshot 保存を追加する。
- `src-electron/session-runtime-service.ts` と companion runtime に prompt injection を接続する。
- resume / history は catalog 現在値ではなく saved snapshot を使う。
- audit / debug では注入有無を追跡できるようにし、長い本文の常時出力は避ける。

含めないもの:

- `character-notes.md` の常設 prompt 注入
- raw memory / growth history の復活
- provider instruction sync への Character 書き込み

検証:

```bash
npm run typecheck
node --import tsx --test scripts/tests/session-persistence-service.test.ts scripts/tests/session-runtime-service.test.ts
node --import tsx --test scripts/tests/companion-session-service.test.ts scripts/tests/companion-runtime-service.test.ts
```

## Branch 7: Release Gate

目的:

- V5 Core の完了判定を automated checks と manual checklist で固定する。

主な作業:

- `docs/design/manual-test-checklist.md` または V5 Core release gate doc に manual checklist を追加する。
- Character 0 件、Character A / B 登録、New Session、Companion、snapshot、prompt boundary、legacy compatibility を確認する。
- release note に、複数 Character 復帰と自動生成未実装を明記できる状態にする。

検証:

```bash
npm run typecheck
npm test
npm run build
```

packaging 前:

```bash
npm run dist:win
```

## Deferred Branches

V5 Core 完了後に必要性を再判断する。

| Branch | Scope |
| --- | --- |
| `docs/v5-character-authoring-workflow` | Character 定義自動生成、GPT-5.5 Pro 等を使う外部 authoring workflow、review checklist。 |
| `feat/v5-character-advanced-editor` | section Editor、frontmatter Editor、preview、diff、revision、rollback、validator UI、Character Update Workspace。 |
| `design/v5-character-memory-growth-matetalk` | Character Memory、Growth / revision automation、MateTalk replacement / Character Chat 再設計。 |

## Review Rules

- 各 branch は 1 つの論理変更単位にする。
- 実装 branch は docs の scope / non-goals と照合して、Deferred 機能を混ぜない。
- storage、snapshot、prompt injection は data loss と過去 session 互換を優先して review する。
- UI branch は Home / Settings の責務を混ぜすぎない。
