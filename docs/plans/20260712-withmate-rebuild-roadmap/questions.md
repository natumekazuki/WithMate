# Questions

- status: 質問なし
- updated: 2026-07-20

現在、CP3実装を止める回答待ちはない。Q-11は`docs/adr/013-runtime-host-and-run-mutation-control-plane.md`で確認済みである。

## Checkpoint到達時に判断する項目

| ID | 判断項目 | 期限 | 現在の扱い |
| --- | --- | --- | --- |
| Q-01 | Node.js / Electron / TypeScriptの具体versionとpackage構成 | CP1開始時 | 確認済み: Electron 42、Node.js 24、TypeScript 6.0、npm |
| Q-02 | SQLite driverとWorker transport | CP1開始時 | 確認済み: Worker内`node:sqlite`、`worker_threads` |
| Q-03 | CLI command namespaceとstructured output version | CP2開始時 | 確認済み: `withmate session <operation>`、`withmate-cli-v1`。判断理由はADR 006 |
| Q-04 | Characterのユーザー向け名称をMateへ変更するか | CP4開始時 | data modelとUI用語を分離して判断 |
| Q-05 | Memory V6から引き継ぐ概念と捨てる実装 | CP4開始時 | owner / scope / forget / protected object単位で再設計 |
| Q-06 | Auxiliaryのcontext引継ぎ、既定動作、排他範囲 | CP5開始時 | 通常Run / Multi-Agentとの境界を先に固定 |
| Q-07 | Copilot ACP runtime検証環境 | CP6開始前 | 契約済み別環境を準備 |
| Q-08 | Session Monitorを独立Windowとして残すか | CP7開始時 | CLI / Home / Sessionの観測導線を比較 |
| Q-09 | SettingsをGUIとCLIのどちらへ置くか | CP7開始時 | 日常頻度と復旧可能性で機能別に判断 |
| Q-10 | release対象OS、installer形式、署名 | CP8開始前 | packaging設計前に確認 |
| Q-11 | Run mutation / supplemental inputのCLI operation名とprocess model | CP3開始時 | 確認済み: 長寿命WithMate runtime host + local IPC。`withmate run start|retry|send-input|cancel`。判断理由はADR 013 |
| Q-12 | child Sessionへのfollow-up / messageのCLI operation名 | CP5開始時 | Delegationのlatest Message / Runとdeliveryを原子的に更新するApplication contractと同時に確定 |

## Status運用

- `質問なし`: 現在checkpointを止める質問がない。
- `回答待ち`: user判断がないと責務または成果が変わる。
- `確認済み`: checkpointに必要な判断が記録済み。
- 将来checkpointの項目は、期限到達までは回答待ちとして扱わない。
