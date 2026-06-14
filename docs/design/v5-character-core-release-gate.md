# V5 Character Core Release Gate

- 作成日: 2026-06-14
- 対象: V5 Character Core の完了判定
- 関連 plan: `docs/plans/20260613-v5-character-core-branches.md`

## Goal

V5 Core の完了条件を、automated checks、manual checklist、release note、known risks の 4 点で固定する。

V5 Core は「複数 Character へ戻せていること」を release 判定の中心に置く。ここでいう完了は、Character catalog / Settings raw editor / launch selection / runtime snapshot / prompt injection boundary が、current runtime で一貫して使える状態を指す。

## Source Of Truth

| Area | Source |
| --- | --- |
| Branch scope | `docs/plans/20260613-v5-character-core-branches.md` |
| Character format | `docs/design/character-definition-format.md` |
| Character storage / snapshot | `docs/design/character-storage.md` |
| V5 transition / non-goals | `docs/design/v5-character-transition.md` |
| Manual checks | `docs/manual-test-checklist.md` の `V5 Character Core Release Gate` |

## Automated Gate

Release candidate は次の command をすべて通す。

```bash
npm run typecheck
npm test
npm run build
```

Windows packaging 前は次も通す。

```bash
npm run dist:win
```

`npm run dist:win` は Windows packaging runner、または Windows native module rebuild が可能な環境で実行する。macOS からの cross build で native module rebuild が source build に倒れる場合は、`node-gyp does not support cross-compiling native modules from source` で失敗し得るため、packaging environment issue として切り分ける。

`npm test` は Node test runner で `scripts/tests/*.test.ts` / `scripts/tests/*.test.tsx` を全件実行する。`node:sqlite` を使う storage 系 test は Node 22 以上の runtime で実行する。

## Manual Gate

手動確認の正本は `docs/manual-test-checklist.md` の `V5C-*` 項目とする。

必須確認:

- Character 0 件でも Home / New Session / Companion が neutral fallback で起動できる
- Character A / B を登録し、default / explicit selection が New Session と Companion に渡る
- Settings の Character raw editor / import / archive / default が保存後も維持される
- session / companion は開始時点の Character snapshot を保存し、catalog 現在値ではなく saved snapshot を runtime prompt に使う
- `character-notes.md`、Memory / Growth history、provider instruction sync は V5 Core runtime prompt に常設注入されない
- legacy session / legacy DB / existing session summary が壊れず、snapshot が無い session は空 system prompt のまま動く

## Release Note Draft

```md
### V5 Character Core

- 複数 Character catalog を再導入し、Settings から Character を作成・編集・既定設定・archive できるようにしました。
- New Session と Companion 起動時に Character を選択できるようにしました。Character が 0 件の場合も neutral fallback で起動できます。
- session / companion 開始時点の `character.md` を runtime snapshot として保存し、その保存済み snapshot を coding agent prompt に注入します。後から Character catalog を編集しても、既存 session の人格定義は開始時点の snapshot を使います。
- `character-notes.md`、Memory / Growth history、provider instruction sync への Character 書き込みは V5 Core では未実装です。
- Character 定義自動生成、詳細 section editor、revision / diff / rollback、Character Update Workspace は後続 scope です。
```

## Known Risks

| Risk | Release stance |
| --- | --- |
| Character 定義品質の自動評価がない | V5 Core では raw `character.md` editor / import validation までを scope とし、自動生成・人格品質 validator は後続 scope に送る |
| `character-notes.md` が runtime prompt に入らない | 意図した境界。補助ファイルとして保存するが、常設 prompt 注入はしない |
| 既存 session は CharacterRuntimeSnapshot を持たない | legacy compatibility として許容。snapshot が無い session は従来通り空 system prompt で動く |
| Character catalog 更新が既存 session に反映されない | 意図した snapshot 境界。既存 session は開始時点の `character.md` を正本にする |
| Windows packaging は native module rebuild、cross build、外部 download、signing に左右される | release candidate 前に `npm run dist:win` を別 gate として実行し、失敗時は packaging environment / installer / binary download / signing 由来かを切り分ける |

## Completion Criteria

V5 Core は次をすべて満たした時点で release-ready とする。

- Branch 2 から Branch 6 が `develop` に merge 済み
- Automated Gate が green
- Manual Gate の `V5C-*` 項目が確認済み
- Release note draft が実際の release note へ転記できる
- Known Risks が release blocker ではなく、Deferred Branches または明示的な release stance に分類されている
