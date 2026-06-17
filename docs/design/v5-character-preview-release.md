# V5 Character Preview Release

- 作成日: 2026-06-14
- 対象: V5 Character Core preview release 判定
- 関連: `docs/design/v5-character-core-release-gate.md`

## Release Note Draft

### V5 Character Core Preview

WithMate V5 preview では、Character-first の初期実装として、複数 Character catalog、Settings の最低限 Character editor、New Session / Companion での Character 選択、session 開始時点の runtime snapshot、provider prompt への `character.md` 注入を追加した。

Added:

- 複数 Character catalog を再導入
- Settings の `Characters` section
  - Character 一覧
  - 新規作成
  - name / description / icon path / theme 編集
  - raw `character.md` editor
  - optional `character-notes.md` editor
  - import / replace
  - save / cancel
  - set default
  - archive
- New Session / Companion 起動時の Character selection
- Character 0 件時の neutral fallback
- session / companion 開始時点の `CharacterRuntimeSnapshot`
- provider prompt system 側への保存済み `character.md` snapshot 注入
- catalog 更新が既存 session の snapshot を書き換えない境界
- markdown code fence を含む `character.md` の prompt fence boundary
- Home / summary list が重い `character.md` 本文を持たない境界

Not included:

- Character 定義自動生成
- GPT-5.5 Pro 等を使う authoring workflow の WithMate 内組み込み
- 詳細 section editor
- validator UI
- revision / diff / rollback
- Character Update Workspace
- Character Memory / Growth 再設計
- MateTalk / Character Chat
- Multi-agent / Browser Preview / 放牧

Compatibility:

- `CharacterRuntimeSnapshot` を持たない既存 session は、Character system prompt なしで従来通り実行できる。
- Character catalog 更新は既存 session へ自動反映されない。既存 session は開始時点の snapshot を runtime 正本として使う。
- `character-notes.md`、Memory / Growth history、provider instruction sync 由来の Character 書き込みは V5 Core runtime prompt へ常設注入されない。

Known risks:

- Character 定義品質は手動作成 / 手動 import に依存する。
- preview では Character 品質 validator や自動生成は提供しない。
- Windows packaging は native module rebuild や runner 環境に依存する場合がある。
- legacy MateTalk を使っていたユーザー向けの代替 Character Chat は preview には含めない。

## Verification Checklist

Automated:

```bash
npm run typecheck
npm test
npm run build
```

Packaging:

```bash
npm run dist:win
```

`npm run dist:win` は Windows packaging runner、または Windows native module rebuild が可能な環境で実行する。

Manual V5C Gate:

- [ ] V5C-001 Character 0 件 fallback
- [ ] V5C-002 Character A/B 登録
- [ ] V5C-003 Default Character
- [ ] V5C-004 New Session explicit selection
- [ ] V5C-005 Companion explicit selection
- [ ] V5C-006 Snapshot boundary
- [ ] V5C-007 Prompt boundary
- [ ] V5C-008 Markdown fence boundary
- [ ] V5C-009 Legacy compatibility
- [ ] V5C-010 Summary performance boundary

Cleanup confirmation:

- [ ] MateTalk hidden runtime / route が current runtime から外れている
- [ ] manual checklist に V5 current と矛盾する旧 MateTalk 項目がない
- [ ] Settings docs が現行 UI と一致している
- [ ] prompt composition docs が `CharacterRuntimeSnapshot` 境界を説明している
- [ ] release note draft が preview として説明可能

Release decision:

- [ ] automated gate green
- [ ] manual gate pass
- [ ] known risks reviewed
- [ ] V5 preview release note ready
- [ ] preview tag / release 作成へ進める
