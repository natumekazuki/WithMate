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

## D-006: control planeとruntime orchestrationをcheckpointで分離する

- date: 2026-07-19
- status: accepted

CP2はProvider非依存の永続control planeを担当し、Session操作、Message timeline、Session Run history、Run status / events / outputをApplication ServiceとCLIから利用可能にする。CP3はProvider runtimeを必要とする単一SessionのRun start / retry / active cancel、supplemental input、approval / elicitation responseを担当する。CP5はchild Session / Delegationのstart / follow-up / message / wait / collect / cancel / killを担当する。

Run開始や追加指示はProvider dispatch、live runtime、外部副作用との相関を必要とするため、Provider未接続のCP2 Gateへ含めない。childへの追加指示はDelegationのlatest Message / Runとdeliveryを同じorchestration contractで更新する必要があるため、CP5へまとめる。具体的なCLI operation名は各checkpointでpublic contractを確定するときに決める。

CP6はCP3で成立した共通Run operationへCopilot Adapterを接続するため、CP3に依存する。Session Files cleanupとRun output export temporary fileのorphan sweep / crash recoveryは、運用hardeningを担当するCP8へ置く。

## D-007: Run mutationを長寿命runtime hostへ集約する

- date: 2026-07-20
- status: accepted

CLIやWindowから独立した長寿命WithMate runtime hostがPersistence Worker、Provider接続、live Run、draft、interactionを所有する。Operational CLIはlocal IPC clientとし、CLI connection終了をRun cancelまたはProvider disconnectへ変換しない。

Codexはruntime hostが所有するstdio App Server childを使い、Codex managed daemonを初期依存にしない。public CLI operation名は`withmate run start`、`withmate run retry`、`withmate run send-input`、`withmate run cancel`とする。owner、IPC、recovery、alternatives、consequencesはADR 013を正本とする。
