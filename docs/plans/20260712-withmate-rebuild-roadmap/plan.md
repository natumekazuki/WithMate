# WithMate Rebuild Roadmap

- 作成日: 2026-07-12
- plan tier: repo plan
- 状態: active
- 現在地: CP1進行中、S5完了・S6着手前
- questions status: 質問なし

## Task Brief

Goal: ゼロベース再構築を、依存関係と通過条件が明確なcheckpointへ分割する。
Scope: persistence、Application Service / CLI、Provider、Character / Memory、Multi-Agent / Auxiliary、GUI、release。
Out of scope: `feature-inventory.md`でDropまたはDeferとした機能、旧実装の移植計画、期日見積り。
Done when: CP0からCP8までの成果物、検証Gate、依存関係、保留判断が一意に追跡できる。
Risks: subsystemごとの先行実装、外部Provider検証待ち、GUI先行、旧設計の混入、checkpointの名目完了。

## 成功条件

- CLIから主要use caseを操作でき、GUIは同じApplication Serviceを利用する。
- CodexとGitHub CopilotのProvider固有protocolがAdapter内に閉じる。
- Session / Message / Run、Multi-Agent、Provider相関がschema version 1の契約どおり永続化される。
- CharacterとMemoryがProvider promptへ責務分離された形で反映される。
- 通常Session、Auxiliary、Multi-Agent childが共通Run contractで実行・復旧できる。
- clean installから起動、主要操作、終了、再起動復旧、packagingまで自動検証できる。

## 進行原則

1. checkpointは成果物の作成ではなく、Gateの通過で完了とする。
2. 下位層から進め、GUIやProvider固有処理から永続化を直接操作しない。
3. 各checkpoint開始時に`questions.md`を確認し、回答待ちなら実装前に解消する。
4. 設計判断は`docs/design/`、計画と進捗は本directory、実測は`docs/investigations/`を正本とする。
5. `old/`は挙動調査の参考に限定し、API、schema、責務境界を移植しない。
6. checkpoint完了時にtargeted test、主要回帰、未検証事項、残リスクを`worklog.md`へ記録する。

## Checkpoint一覧

| CP | 名称 | 状態 | 主な到達点 | 依存 |
| --- | --- | --- | --- | --- |
| CP0 | Scope / Design / Schema Foundation | 完了 | 初期scope、Provider方針、Session / Run / Message、Multi-Agent、14 table、schema v1 DDL | なし |
| CP1 | Runtime / Persistence Foundation | 進行中 | project scaffold、Persistence Worker、bootstrap、repository API、write ownership | CP0 |
| CP2 | Application Service / CLI Control Plane | 未着手 | use case、error envelope、idempotency、CLI基本操作 | CP1 |
| CP3 | Codex Single-Session Vertical Slice | 未着手 | CodexでSession作成からRun完了・復旧までE2E | CP2 |
| CP4 | Character / Memory / Prompt Layer | 未着手 | Character snapshot、prompt composition、Memory target / CLI境界 | CP3 |
| CP5 | Multi-Agent / Auxiliary Orchestration | 未着手 | child delegation、wait / collect、Auxiliary、capacity、復旧 | CP3、CP4 |
| CP6 | Copilot / Model Catalog | 未着手 | Copilot ACP Adapter、model / capability取得、fallback | CP2、別環境検証 |
| CP7 | GUI Core | 未着手 | Home、Session、Character、Monitor、必要最小Settings | CP3〜CP5。Copilot UIはCP6 |
| CP8 | Hardening / Packaging / Release Readiness | 未着手 | performance、privacy、recovery、packaging、clean-install smoke | CP6、CP7 |

## CP0: Scope / Design / Schema Foundation

### 成果物

- `docs/index.md`
- `docs/feature-inventory.md`
- `docs/issue-triage.md`
- Session Persistence Design Review Set
- `docs/design/sqlite-schema-lifecycle.md`
- `schema/sqlite/v1.sql`
- `schema/sqlite/manifest-v1.json`
- `scripts/validate-sqlite-schema.py`

### Gate

- Keep / Reconsider / Defer / Dropが分類されている。
- 14 tableとschema version 1の完全DDLが一致する。
- schema hash、PRAGMA、FK、CHECK、stored payload原子性を機械検証できる。
- 旧DBを参照、変更、migrationしない境界が明記されている。

### 状態

完了。未コミット差分として存在するため、次回commit時は本roadmapを含む論理単位を確認する。

## CP1: Runtime / Persistence Foundation

詳細Plan: `docs/plans/20260712-cp1-runtime-persistence/plan.md`

### 目的

SQLiteを単一のPersistence Worker / actorが所有し、上位層へtransaction-safeなrepository APIだけを公開する。

### 主な作業

1. Node.js / Electron / TypeScriptの最小project scaffoldとtest runnerを確定する。
2. DB connection lifecycle、Worker境界、write queue、read経路、shutdownを設計・実装する。
3. 新規DB bootstrap、identity / version / manifest検証、非対応DB拒否を実装する。
4. Session作成、Message + Run admission、Run terminal、Run output、child deliveryのrepository commandを実装する。
5. role、同一Session所属、状態遷移、quota、idempotencyをcontract test化する。

### Gate

- Main process / Renderer / CLIがSQLite connectionを直接所有しない。
- concurrent writeがWorkerで直列化され、transaction失敗時に部分rowを残さない。
- schema validatorがtest runnerから実行される。
- admission、terminal、stored payload、binding / attempt、deliveryの代表contract testが通る。
- Worker異常終了と正常shutdownでDB corruptionや未処理requestの成功扱いがない。

## CP2: Application Service / CLI Control Plane

### 目的

画面に依存しない主要use caseと、同じ契約を操作するCLIを成立させる。

### 主な作業

- Session create / list / read / archive / close / delete
- Run start / status / follow / cancel / retry
- supplemental input、child operation、output preview / chunk / export
- operation error、partial success、persistence status、idempotency envelope
- structured output、exit code、authorization / workspace検証

### Gate

- CLIだけでProvider未接続のdomain / persistence use caseを再現できる。
- exact retry、duplicate key、response切断後再送が契約どおり収束する。
- Application Service以外からrepository write commandを組み立てない。
- CLI operationのcontract testとhelp / structured output testが通る。

## CP3: Codex Single-Session Vertical Slice

### 目的

Codex App Serverを使い、1 Sessionの作成、実行、途中経過、完了、cancel、再起動復旧をE2Eで成立させる。

### 主な作業

- process lifecycleとJSON-RPC transport
- Thread / Turn / item mapping
- final MessageとRunOutputの分離
- model、reasoning、approval、sandbox、workspace設定
- interrupt、steer、approval / elicitation runtime検証
- daemon client-only切断を含む残りのrecovery mapping

### Gate

- CLIからCodex Runを開始し、final Messageとdetail outputを分離して取得できる。
- cancel、process crash、app再起動がRun contractどおりterminalへ収束する。
- ambiguous dispatchを自動再送しない。
- Provider raw payloadやsecretを永続化しない。

## CP4: Character / Memory / Prompt Layer

### 目的

WithMate固有価値を、ProviderやSession runtimeへ責務を漏らさず追加する。

### 主な作業

- Character定義、archive、snapshot、authoring format
- Session開始時のCharacter snapshot
- system / developer / user inputとのprompt composition
- project、user-global、character、character + projectのMemory target
- search / append / forget / correctionとWithMateCLI境界
- Memory注入量、privacy、protected objectの再設計

### Gate

- 同じRun snapshotから同じprompt構成を再現できる。
- CharacterとMemoryの正本・更新時点・Runへの固定境界が明確である。
- secret、raw log、大容量payloadをMemoryへ保存しない。
- Characterなし、MemoryなしでもSession実行が成立する。

## CP5: Multi-Agent / Auxiliary Orchestration

### 目的

通常Runと同じ基盤上で、delegation treeとAuxiliary実行を安全に成立させる。

### 主な作業

- start / follow-up / message / wait / collect / cancel / kill
- root / app / Provider capacity admission
- Hook通知、result availability、first collection
- clarification、explicit retry、parent turnをまたぐ継続
- Auxiliary固有policy、親Session排他、context引継ぎ
- crash recoveryとorphan修復

### Gate

- `waitChild` / `waitAny` / `waitAll`がread-onlyである。
- `collectChildResult`だけが初回回収と親tool resultを確定する。
- parent終了でchildを暗黙cancelしない。
- capacity、idempotency、recursive tree、restart recoveryのcontract testが通る。

## CP6: Copilot / Model Catalog

### 目的

GitHub Copilot ACPを共通Provider contractへ接続し、Provider差をAdapter内へ閉じる。

### 主な作業

- Copilot契約済み別環境でACP runtime validation
- Session resume、cancel、steer、permission、並行実行mapping
- model / capability catalog取得
- catalog refresh / export / validate / import
- 取得不能時のbundled fallback

### Gate

- CodexとCopilotが同じApplication Service operationで実行できる。
- capability未確認機能を利用可能として公開しない。
- runtime検証結果と対象CLI / protocol versionが記録される。
- 別環境検証不能の場合はCP6を未完了のまま明示し、CP7のCopilot UIをrelease対象にしない。

## CP7: GUI Core

### 目的

CLIで成立したuse caseへ、必要最小限のElectron GUIを接続する。

### 主な作業

- Home: Session一覧、起動、Character / Settings導線
- Session: timeline、composer、live activity、approval / input、details遅延読込
- Character Editor
- Session Monitorの配置判断と実装
- 必要最小限のProvider / model / additional directory設定
- accessibility、keyboard、loading / error / empty state

### Gate

- RendererがProvider processやSQLiteを直接操作しない。
- Window closeでRun、Provider connection、draft、pending interactionを破棄しない。
- 大量Session / Message / outputでN+1、全件hydrate、巨大payload複製がない。
- CLIとGUIでdomain outcomeとerror semanticsが一致する。

## CP8: Hardening / Packaging / Release Readiness

### 目的

clean installから日常利用までの安全性、性能、配布可能性を確認する。

### 主な作業

- structured app log、diagnostics、privacy / redaction review
- DB quota、disk reserve、WAL、checkpoint、incremental vacuum実測
- crash / restart / shutdown / partial persistence fault injection
- provider binary / app server staging
- Electron packaging、icon、installer、tag build
- clean-install、upgrade refusal、uninstall / data残存方針

### Gate

- clean environmentでinstall、起動、Session実行、再起動復旧、終了が通る。
- release artifactに必要なProvider runtimeが含まれ、認証情報を含まない。
- performance budgetと主要failure modeの実測値が残る。
- 既知の未検証事項とrelease blockerが0件、または明示的に除外承認される。

## Critical Path

```text
CP0 → CP1 → CP2 → CP3 → CP4 → CP5 → CP7 ┐
                  └────────→ CP6 ────────┴→ CP8
```

- CP6の調査準備はCP1〜CP5と並行できるが、完了にはCopilot契約済み環境が必要。
- GUI wireframeやvisual explorationは先行できるが、production実装はCP2 / CP3のAPI契約確定後とする。
- Character / MemoryとMulti-Agentの設計調査は先行できるが、永続化実装はCP1のrepository境界を通す。

## 初期版から除外するもの

- 旧DB migration / import / compatibility reader
- Companion mode
- Diff / artifact専用GUI
- Memory management GUI
- Browser Preview / Browser Use
- scheduler / background task
- monologue / Character Stream
- Provider instruction sync
- 自動retentionとProvider側会話削除の連動はCP8までの必須scopeにせず、別Design Gateで追加する。

## 更新規則

- checkpoint開始時に状態を`次に着手`から`進行中`へ更新する。
- Gateをすべて満たした場合だけ`完了`へ更新する。
- scope変更は`decisions.md`へ理由を記録し、checkpoint表と`questions.md`を同期する。
- 外部依存で止まるcheckpointは、依存しない作業を分離したうえで`回答待ち`または`外部環境待ち`を明記する。
- セッション終了時は`$session-handoff`で現在checkpoint、最後に通ったGate、次の1手を残す。
