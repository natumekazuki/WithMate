# 作業記録

- `character.md` seed 仕様の実装を開始
- `buildCharacterMarkdownTemplate()` を追加し、`character-definition-format` に沿った最小骨格を定義
- 新規保存時のみ `character.md` が空なら seed するよう `character-storage.ts` を更新
- build と関連 test を通して回帰がないことを確認
- seed テンプレートの見出し階層と section 名の整理は別 task で追従する方針とした
- コミット: `668614f` `feat(character): improve update workspace definitions`
