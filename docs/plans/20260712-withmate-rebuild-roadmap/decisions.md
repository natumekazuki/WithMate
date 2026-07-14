# Decisions

## D-001: Roadmapを9 checkpointに分割する

- date: 2026-07-12
- status: accepted

現在地をCP0とし、CP1からCP8までを依存関係と実行可能なvertical sliceで分割する。細かなtask数ではなく、利用可能な能力と検証Gateをcheckpoint境界にする。

## D-002: CLI先行、GUI後続とする

- date: 2026-07-12
- status: accepted

Application ServiceとCLIで主要use caseを成立させた後、GUIを同じ契約へ接続する。GUI固有状態をdomainまたはpersistenceの正本にしない。

## D-003: Codex vertical sliceを先に完成させる

- date: 2026-07-12
- status: accepted

Codexは現環境でruntime検証可能で、persistent Thread recoveryの実測も存在する。Copilot ACPは別環境依存のため、共通基盤をCodexで先にE2E化し、CopilotはCP6でAdapter互換を検証する。

## D-004: GUI開始条件をAPI契約の確定後とする

- date: 2026-07-12
- status: accepted

GUI visual explorationは先行可能だが、production GUI実装はApplication Service / CLIとCodex single-session contractの成立後に行う。

## D-005: 旧roadmapを正本にしない

- date: 2026-07-12
- status: accepted

`old/docs/`および`old/docs/plans/`のroadmapは旧実装の履歴であり、現行roadmapの進捗、scope、API、schema判断へ使用しない。
