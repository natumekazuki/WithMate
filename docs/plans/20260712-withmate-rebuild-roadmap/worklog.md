# Worklog

## 2026-07-12: Roadmap作成

- repo planを作成した。
- `docs/index.md`、`docs/feature-inventory.md`、`docs/issue-triage.md`、最新handoff、現行design docsの後続scopeを参照した。
- checkpointをCP0からCP8の9段階に分割した。
- CP0を完了、CP1を次に着手とした。
- CP1を止める質問はない。stack / SQLite driver / Worker transportはCP1開始時に調査して確定する。
- 旧roadmapは`old/`の参考資料に限定した。

## 2026-07-12: CP1開始

- `docs/plans/20260712-cp1-runtime-persistence/plan.md`を作成した。
- CP1を`進行中`へ更新した。
- 現在地はS1 Stack / Driver / Transport Decision着手前。
- S1開始を止める回答待ちはない。

## 2026-07-12: CP1 S1完了

- runtime、package manager、SQLite driver、Worker transport、test runnerを確定した。
- CP1の現在地をS2 Project Scaffold着手前へ進めた。

## 2026-07-12: CP1 S2完了

- rootに新実装のpackage、TypeScript build、test、format、module boundary scaffoldを追加した。
- Node.js 24とElectron 42同梱Node.jsでruntime persistence probeを確認した。
- CP1の現在地をS3 SQLite Bootstrap / Schema Verification着手前へ進めた。

## 2026-07-12: CP1 S3完了

- SQLite bootstrap、schema manifest検証、非対応DBの非破壊拒否を実装した。
- WAL / rollback journalを含む既存DBをsnapshot側で分類し、旧DB path aliasをopen前に拒否する契約を追加した。
- CP1の現在地をS4 Persistence Worker Lifecycle着手前へ進めた。

## 2026-07-12: CP1 S4完了

- Persistence Workerの世代付きprotocol、single FIFO、timeout / cancel、crash / shutdown lifecycleを実装した。
- 最大256 KiBのpayload chunk transfer経路とconstant-memoryのrequest replay拒否を追加した。
- CP1の現在地をS5 Repository Read Model着手前へ進めた。
- CP1 S5でscope付きbounded Repository read、opaque cursor、Message / payload chunk分離を実装し、現在地をS6着手前へ進めた。
- CP1 S6-Aでtyped write command、idempotency基盤、Session create / lifecycle transitionを実装し、現在地をS6-B着手前へ進めた。
- CP1 S6-B1で通常Run admissionを実装し、Message / Run / Attempt / Dispatch / Binding intent / IdempotencyRecordの一括commitを成立させた。
- CP1 S6-B2aでProvider Bindingのactive / ambiguous resolutionを実装し、ephemeral live ownershipをWorker memoryへ限定した。
- CP1 S6-B2bでDispatch共通Gate、送信intent、accepted / rejected / ambiguous resolutionを実装した。

## 2026-07-14: CP1完了

- S8 Integration Gateでpublic repository API、Main / Worker依存境界、clean install、Windows compiled smoke、SQLite sidecar cleanup、性能baselineを確認した。
- Node.js 24で全116 test、schema validator、runtime probe、lint、typecheck、build、formatを通し、materialなcorrectness / data-loss findingがないことを確認した。
- CP1を`完了`へ更新し、現在地をCP2 Application Service / CLI Control Plane着手前へ進めた。
