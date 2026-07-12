# Questions

- status: 質問なし
- updated: 2026-07-12

S1の判断項目は確認済みで、S2開始を止める回答待ちはない。

| ID | 判断項目 | 状態 | 解消条件 |
| --- | --- | --- | --- |
| Q1-01 | Node.js / Electron / TypeScriptのversion組合せ | 確認済み | Electron 42最新patch、Node.js 24.16以上、TypeScript 6.0系 |
| Q1-02 | package manager / lockfile | 確認済み | npmと`package-lock.json` v3、direct dependencyはexact version |
| Q1-03 | SQLite driver | 確認済み | Worker内の`node:sqlite` `DatabaseSync`、backup APIとchunk read |
| Q1-04 | Worker transport | 確認済み | `worker_threads`、version付きmessage、transferable `ArrayBuffer` |
| Q1-05 | test runner / build path | 確認済み | Node.js test runner、`tsx --test`、TypeScript NodeNext / ESM |

## 回答待ちへ切り替える条件

- distribution sizeとruntime安全性など、技術調査だけでは決められないproduct trade-offがある。
- supported OSやinstaller方式をCP1で先に固定しないとdriverを選べない。
- native dependencyを許容するかどうかで実装可能性が大きく変わる。
- 既存の未コミット方針と矛盾する選択が必要になる。
