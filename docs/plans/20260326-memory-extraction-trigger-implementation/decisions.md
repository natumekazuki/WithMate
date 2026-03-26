# Decisions

- 2026-03-26: trigger 判定軸は provider ごとの `outputTokensThreshold` に統一する。
- 2026-03-26: extraction は通常会話とは別の裏処理として扱う。
- 2026-03-26: `compact 前` の強制 trigger は、アプリ側に compact 実行導線が無いため current slice の完了条件から外す。
