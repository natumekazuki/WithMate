# ADR 037: Session Graphを廃止する

[Issue #985](https://github.com/natumekazuki/WithMate/issues/985)の決定により、Session Graphを廃止する。製品更新でGraph専用保存データは退避せず破棄し、通常Session、保存履歴、Coordination、Glossary、参照先の利用者ファイルは保持する。互換入口や代替の共有記録機構は設けない。

削除commit: [666c5facc5192d07d02e998ba61c3eb446dfaeef](https://github.com/natumekazuki/WithMate/commit/666c5facc5192d07d02e998ba61c3eb446dfaeef)。利用規則・Skill・hookの撤去は別リポジトリの[.codex #171](https://github.com/natumekazuki/.codex/issues/171)で扱う。
