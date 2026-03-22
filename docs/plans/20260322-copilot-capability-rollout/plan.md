# Plan

## Goal

- `docs/design/coding-agent-capability-matrix.md` を基準に、`GitHub Copilot CLI` 対応を capability 単位で順番に進める
- 1 capability = 1 follow-up task の切り方で、段階的に Copilot parity を上げる
- まずは `同じ Session UI で最低限使える` 状態までの順番を固定する

## Scope

- Copilot 対応 capability の実装順序決定
- slice ごとの完了条件定義
- follow-up task の切り出し方針整理

## Out Of Scope

- Copilot runtime 実装
- SDK 検証
- UI 実装

## Rollout Principle

- `coding-agent-capability-matrix.md` の 1 行を、原則 1 follow-up task として切る
- dependency が強い capability だけは同じ slice にまとめる
- provider native support が `未確認` の項目は、実装前に小さな調査 task を挟む
- 各 slice 完了時には `docs/design/coding-agent-capability-matrix.md` を更新する

## Slice Order

### Milestone A: Session UI で最低限動かす

1. `基本 turn 実行`
   - Copilot adapter を通して 1 turn 実行できる
2. `assistant text streaming`
   - 既存 Session UI で stream を出せる
3. `model selection`
   - session metadata から Copilot model を選べる
4. `session 再開`
   - Copilot 側 session/thread 識別子を保存し、継続実行できる
5. `cancel / interrupted handling`
   - Cancel 後の state と UI が崩れない
6. `audit log`
   - prompt / response / provider metadata の最小記録が残る

### Milestone B: 日常利用に足る parity

7. `approval mode`
   - `allow-all / safety / provider-controlled` を Copilot native 設定へ map する
8. `partial result preservation`
   - canceled / failed の途中結果を保存する
9. `command visibility`
   - `Latest Command` に相当する情報を Session 右 pane へ出す
10. `file / folder context`
    - workspace file / folder を Copilot turn input に反映する
11. `image attachment`
    - image input の可否を確定し、対応するなら Session UI に繋ぐ
12. `changed files / diff`
    - artifact summary と diff viewer を Copilot 実行結果でも維持する

### Milestone C: provider-specific capability

13. `skill selection`
    - Copilot skill directive を current Skill picker に繋ぐ
14. `custom agent selection`
    - Copilot `/agent` 相当を session metadata と adapter mapping に繋ぐ
15. `slash command absorption`
    - 必要最小限の canonical command を Copilot でも使えるようにする
16. `apps / mcp / plugins`
    - provider extension をどこまで wrapper 吸収するか決める
17. `sandbox / allowlist 拡張`
    - allowlist / plugin / policy enforcement を WithMate からどこまで触るか決める

### Deferred

18. `live step timeline`
    - command 以外の step 可視化は、まず `Latest Command` parity が取れてから
19. `app-level approval callback`
    - SDK surface が見えない限り実装対象にしない
20. `native slash passthrough`
    - current 方針では非対象のまま維持する

## First Follow-Up Tasks

- 最初の実装 task は `基本 turn 実行`
- その次は `assistant text streaming`
- `session 再開` と `cancel` は Copilot SDK / CLI の session surface が見えてから切る

## Affected Docs

- `docs/design/coding-agent-capability-matrix.md`
- `docs/design/provider-adapter.md`
- `docs/design/codex-approval-research.md`

## Risks

- Copilot 側で `未確認` が多い capability を、実装前の調査なしで進めると順番が崩れる
- Codex 前提の audit log / artifact schema が Copilot にそのままは乗らない可能性がある
- capability をまとめすぎると、matrix と follow-up task の対応が壊れる
