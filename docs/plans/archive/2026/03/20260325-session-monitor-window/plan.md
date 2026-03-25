# 20260325 session-monitor-window

## Goal

- Home 右ペインの `Session Monitor` を独立した monitor window として切り出す
- 細くコンパクトな window をディスプレイ端に置いて、実行中 session を常時監視できるようにする
- 既存 `Session Window` や `Home` を開き直さなくても、最小情報で run 状態を追えるようにする

## Scope

- `Session Monitor Window` の新設
- compact / narrow 前提の window chrome と layout 設計
- `Home` の `Session Monitor` truth source を再利用する
- monitor row から対象 session を開く導線
- 常時前面表示を含む window option の整理

## Out Of Scope

- monitor window 内での full chat 表示
- full activity timeline の常設表示
- 端への自動吸着や OS ごとの高度な dock animation
- キャラ / Home / Session 全体の大規模 redesign

## UX Assumption

- 初期 slice は「縦長で細い monitor window」を想定する
- 既定は `always on top` を前提に検討する
- 置き場所はユーザーが自由に動かせる前提にし、自動で端へ吸着させる挙動は後回しにする

## Steps

1. `Home Session Monitor` の truth source と row 情報を reusable view model として切り出せるか確認する
2. `Session Monitor Window` の IPC / window lifecycle / open action を整理する
3. narrow window に合わせた layout と row density を決める
4. `always on top` と close / reopen の挙動を決める
5. docs/design と manual test 観点を更新する
