# Decisions

## 2026-04-26

- 正式 Design Doc は `docs/design/companion-mode.md` に作成する。
- `docs/CompanionModeQuestions.md` は確認事項の supporting doc として残す。
- Companion Mode は Git repo root を対象にし、Agent Mode の任意 directory 起動とは分ける。
- Companion の merge は file 選択式の squash merge / patch apply 相当とし、Companion 側の Git 履歴を target branch へ持ち込まない。

