# 結果

- `character.md` の seed テンプレートを prompt 合成の `# Character` section と整合する見出し階層へ修正した
- `name` と `description` は frontmatter を正本とし、本文は `## Character Overview` から始める構成で統一した
- `## System Prompt` section は current 仕様と噛み合わないため削除し、`character.md` 全体を prompt 定義として扱う方針へ揃えた
- 関連 docs と test を current 仕様へ更新した
- 対応コミット: `668614f` `feat(character): improve update workspace definitions`
