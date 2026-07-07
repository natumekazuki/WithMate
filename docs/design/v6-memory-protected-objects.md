# V6 Memory Protected Objects

- 作成日: 2026-07-05
- 対象: V6 Memory に紐づく暗号化ファイル object / CLI / quota / GC 設計
- Status: Design proposal
- 関連:
  - `docs/design/v6-memory-foundation.md`
  - `docs/design/v6-database-foundation.md`
  - `docs/design/database-v3-blob-storage.md`

## Goal

V6 Memory に、画像、スクリーンショット、ソース断片、ログ archive など、SQLite の `TEXT` に直接保存するより file として保持した方が自然な補助資料を紐づけられるようにする。

Protected Object は Memory entry 本文の代替ではない。Memory entry は引き続き `title` / `preview` / `body` / `tags` によって検索、理解、整理できる text-first domain とし、file は必要時だけ WithMate 経由で復元する暗号化 object として扱う。

成立させること:

- file を DB `TEXT` / SQLite `BLOB` に直接保存しない。
- file 実体は Memory 専用 directory に random opaque name で保存する。
- file 実体は WithMate Memory service だけが復元できる形で暗号化する。
- CLI は thin client として runtime Memory API を呼び、復号鍵を持たない。
- file 付き Memory でも、file を復元せずに text だけで概要、保持理由、削除可否を判断できる。
- WithMate 全体の Memory file quota を持ち、append 時に quota 超過を拒否する。
- Memory Review / 管理画面から GC を実行できる。
- CLI から全体使用量と容量を消費している Memory 候補を確認できる。
- `forget` によって不要な file object を削除または `delete_pending` 化し、容量削減の通常導線にする。

## Position

- `docs/design/v6-memory-foundation.md` を V6 Memory API / owner / scope / mutation / privacy の正本とする。
- 本書は V6 Memory foundation の supporting design として、file object 追加時の storage、contract、quota、GC、CLI 拡張を扱う。
- V3 blob store の前例は DB 外 payload、opaque id、summary-first read path、GC の参考にする。ただし V6 Memory Protected Object は暗号化、Memory owner / scope、agent-facing CLI usage を別途定義する。
- V6 first release の legacy Memory import / migration 境界は変更しない。

## Non-Goals

- Memory entry 本文を file に置き換えること
- file 内容の全文検索
- image OCR / vision summary の自動生成
- embedding / vector index
- cloud sync
- cross-target file sharing
- folder tree の自動取り込み
- CLI への復号鍵配布
- agent-facing hard purge API
- 通常 search / get-entry で file 実体や復号済み path を返すこと

## Domain Model

### Memory Entry

既存の `memory_entries_v6` は text-first の正本として維持する。

file 付き append では、次を必須にする。

- `title`: Memory の主題
- `preview`: search result だけで概要が分かる短い説明
- `body`: file を復元しなくても、何を記録した Memory か、なぜ保持するか、削除判断に必要な情報が分かる説明
- `tags`: 後から検索 / 整理しやすい分類

file が存在しても、search / get-entry の主要判断は text metadata だけで完結できる必要がある。

### Protected Object

Protected Object は暗号化された file 実体と、その metadata である。

概念上の主な field:

```ts
type MemoryProtectedObject = {
  objectId: string;
  owner: MemoryOwnerRef;
  scope: MemoryScopeRef;
  mediaKind: "image" | "text" | "source" | "archive" | "document" | "other";
  contentType: string;
  originalBytes: number;
  storedBytes: number;
  encryptedBytes: number;
  rawSha256: string | null;
  ciphertextSha256: string;
  encryptionAlg: string;
  keyId: string;
  nonce: string;
  state: "active" | "delete_pending" | "deleted" | "missing";
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
```

`objectId` は random opaque id とする。元 file path や元 file name から生成しない。file system 上の実体 path は `objectId` と shard rule から Memory object store が決定し、DB や renderer response に実 path を出さない。

`rawSha256` は重複検出や integrity 用に使えるが、同一内容の存在を推測できる情報でもある。初期実装では dedupe を必須にせず、保持する場合も agent-facing response には出さない。

### File Reference

Memory entry と Protected Object の関連は別 table / domain とする。

```ts
type MemoryEntryFileRef = {
  entryId: string;
  objectId: string;
  role: "evidence" | "source" | "snapshot" | "artifact" | "reference" | "other";
  summary: string;
  displayName: string | null;
  sortOrder: number;
  createdAt: string;
};
```

`summary` は必須とする。search / get-entry では file 実体ではなく、`role`、`summary`、`mediaKind`、`contentType`、`originalBytes`、`objectId` を返す。

`displayName` は任意とする。元 file name を保存したくない privacy case があるため、元 file name を必ず保持しない。

## Storage Layout

保存先の概念:

```text
<userData>/
  withmate-v6.db
  memory-objects/
    v6/
      <shard>/
        <object_id>.bin
        <object_id>.json
```

実 file path は Memory object store 内部でのみ扱う。renderer、provider、CLI response へは出さない。

file write は次の順序を基本にする。

1. input file を `stat` して `originalBytes` を得る。
2. quota preflight を行う。
3. input file を streaming read し、必要なら圧縮する。
4. WithMate Memory service 内で AEAD 暗号化する。
5. staging file へ書く。
6. hash / size を検証する。
7. final object path へ atomic rename する。
8. DB transaction で object metadata と entry ref を保存する。
9. DB transaction 失敗時は今回 prepare した object file を best-effort delete し、削除できず残った場合だけ orphan object として GC 対象にする。

巨大 file を quota 判定前に全読み込みしない。
初期 importer は `stat` による inspection と暗号化済み object write を分けられる形にし、application service 側で `usedBytes + incomingOriginalBytes` の quota preflight を済ませてから file read / encrypt / object write へ進む。

## Encryption

Protected Object の保護は file name ではなく暗号化で行う。

- 暗号方式は AEAD を使う。
- 初期実装の payload envelope は `AES-256-GCM` を使い、random 96-bit nonce、128-bit auth tag、ciphertext を単一 binary payload として object store に渡す。
- envelope helper は key material と key id を注入される純粋な暗号化境界とする。
- key store は `memory-keys/v6-keyring.json` に active data key metadata と OS credential store / platform key store 相当で wrap された key material を保存する。平文 key material は DB、object directory、CLI response、audit payload へ保存しない。
- 初期 key store は単一 active key を扱い、将来の key rotation に備えて key id と key list 形式を維持する。
- key id は random 32 桁 hex とし、active key 取得と key id 指定取得を分ける。
- 復号鍵は DB や object directory に保存しない。
- 復号鍵は WithMate Memory service が OS credential store / platform key store 相当から取得する。
- CLI は復号鍵を持たない。
- CLI は runtime Memory API へ export / get-file request を送り、WithMate Memory service が target / permission を検証して復号する。
- 復号済み bytes は通常 API response や renderer state に常駐させない。
- 復号済み temp file は標準 read path にしない。明示 export で caller が指定した output path へ書く。

暗号化は at-rest data leakage を軽減するための境界である。同一 OS user で起動中 WithMate runtime に正規 access できる主体からの access は、Memory API の permission / target validation によって制御する。

## Quota

quota は WithMate 全体の Memory Protected Object 合計に対して設定する。初期実装では一括 read / encrypt / write の安全境界として、個別 file size limit を `64 MiB` に固定する。

quota は Settings で変更できる app setting とし、未設定時は app default を使う。初期 default は実装時に固定するが、設計上は次の制約を持つ bounded setting とする。

- app default を持つ。初期値は `1 GiB` とする。
- Settings から変更できる。
- 最小値 / 最大値を持つ。初期値は `64 MiB` から `50 GiB` とする。
- `Unlimited` は初期公開しない。
- quota 変更は既存 object を削除しない。
- quota を現在使用量より小さくした場合、既存 object は保持するが新規 file append は quota 超過として拒否する。

append 時の判定:

```text
usedBytes + incomingOriginalBytes + estimatedOverhead <= quotaBytes
```

quota 超過時は file write を開始せず、append request 全体を error にする。Memory entry だけを部分保存しない。
storage 層では entry と protected object metadata を同じ transaction で登録し、quota 超過、object metadata 登録失敗、idempotency conflict のいずれでも partial entry / partial object metadata を残さない。
application service は file 付き append で entry id を先に発行し、`entryId + objectId` を暗号化 AAD として使う。request fingerprint は input file metadata 由来の安定値を service から渡し、暗号 nonce や object id の違いで同一 idempotency key が conflict しないようにする。
idempotency key が指定された file 付き append では、service が import 前に storage の replay preflight を行う。既に完了済みの同一 request は file inspection / file read / object write を行わず、保存済み entry を返す。

error response の概念:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "error": {
    "code": "MEMORY_FILE_QUOTA_EXCEEDED",
    "message": "Memory file storage quota would be exceeded.",
    "quotaBytes": 1073741824,
    "usedBytes": 980000000,
    "incomingBytes": 120000000,
    "availableBytes": 93741824
  }
}
```

parallel append で quota を突破しないよう、quota check と object metadata registration は storage service 側で reservation / transaction として扱う。

usage は少なくとも次を区別できるようにする。

- `usedBytes`: quota 判定上の使用量
- `physicalBytes`: DB metadata 上で active / delete_pending として把握している encrypted object size。DB reference を持たない orphan object file は `file-usage` には含めず、GC dry-run の `orphanFiles.bytes` を disk cleanup source とする。
- `pendingDeleteBytes`: `delete_pending` object の容量
- `objectCount`
- `pendingDeleteCount`
- `quotaExceeded`: `usedBytes > quotaBytes` の場合に `true`

## API Contract Extensions

### Append With Files

既存 `memory.append` の request body に `files` を追加する。file 付き append は `--stdin` / `--file` による structured request を正本にし、複雑な request を CLI flags へすべて展開しない。

```ts
type MemoryAppendFileInput = {
  path: string;
  role: "evidence" | "source" | "snapshot" | "artifact" | "reference" | "other";
  summary: string;
  displayName?: string;
  contentType?: string;
};
```

`mediaKind` は request では受け取らず、`role` / `contentType` / `path` から service が推論して response metadata として返す。

validation:

- `files[].path` は local CLI process から読める file path とする。
- directory path は初期実装では拒否する。
- `files[].summary` は必須。
- file 付き append では `body` を必須説明として扱い、空や短すぎる説明を拒否してよい。
- file path は validation / import 処理の入力としてだけ扱い、DB、agent-facing response、audit payload に保存しない。
- file append 実体保存に必要な protected object importer が runtime に設定されていない場合は、validation 後に `MEMORY_FILE_APPEND_UNIMPLEMENTED` を返し、entry / object metadata / idempotency record を作成しない。
- `displayName` / `contentType` は user-facing summary metadata として扱い、表示や永続化へ流す前に改めて escape / normalization 境界を確認する。

### Search / Get Entry

`memory.search` と `memory.get_entry` は file 実体を返さない。

search hit には必要に応じて file summary を含める。

```ts
type MemoryFileSummary = {
  objectId: string;
  role: string;
  summary: string;
  displayName: string | null;
  mediaKind: string;
  contentType: string;
  originalBytes: number;
};
```

`memory.search` は preview-first の原則を維持し、file summary も短い metadata に限定する。
初期実装では entry ref table がまだないため、`role` は protected object metadata に保存して返す。`objectId`、`role`、`summary`、`mediaKind`、`contentType`、`displayName`、`originalBytes` の復号不要 metadata だけを返す。object store path、key id、hash、復号済み bytes は返さない。

### Export File

file 復元は明示 API に分ける。

CLI example:

```powershell
withmate-memory get-file --project <absolute-project-path> --object-id <object-id> --output <output-file>
```

entry 単位 export:

```powershell
withmate-memory export-files --project <absolute-project-path> --entry-id <entry-id> --output-dir <output-directory>
```

service は request target と object owner / scope を照合し、target 外 object を `not_found` に畳む。
初期実装では `get-file` の単一 object export を先に提供し、caller が指定した output path へ復号 bytes を書き出す。既存 output file は上書きしない。
response は `objectId`、`entryId`、`outputPath`、`bytesWritten`、`contentType`、`displayName` のみを返し、object store path、key id、hash、復号済み bytes は返さない。
`export-files` は entry 単位の複数 file export として提供する。caller が指定した output directory を作成し、各 file は object id を prefix にした安全な file name で書き出す。既存 output file は上書きしない。

### Usage

WithMate 全体の Protected Object 使用量を返す read-only command を追加する。

```powershell
withmate-memory file-usage
```

`file-usage` は Memory cleanup の判断に必要な情報を返すが、file path や復号済み content は返さない。

既定では WithMate 全体の集計だけを返す。

```json
{
  "schemaVersion": "memory-v6",
  "quotaBytes": 1073741824,
  "usedBytes": 734003200,
  "physicalBytes": 744488960,
  "pendingDeleteBytes": 10485760,
  "availableBytes": 339738624,
  "objectCount": 42,
  "pendingDeleteCount": 1,
  "quotaExceeded": false
}
```

容量を消費している Memory entry 単位の候補が必要な場合は、`--largest --limit 20` を指定する。
候補は active entry に紐づく active object の `originalBytes` 合計で並べ、file path、object store path、key id、hash、復号済み content は返さない。

```json
{
  "schemaVersion": "memory-v6",
  "quotaBytes": 1073741824,
  "usedBytes": 734003200,
  "physicalBytes": 744488960,
  "pendingDeleteBytes": 10485760,
  "objectCount": 42,
  "pendingDeleteCount": 1,
  "quotaExceeded": false,
  "largestEntries": [
    {
      "entryId": "mem-xxx",
      "title": "debug trace archive",
      "preview": "Issue investigation trace archive.",
      "totalFileBytes": 250000000,
      "fileCount": 3,
      "updatedAt": "2026-07-05T00:00:00.000Z"
    }
  ]
}
```

## CLI Policy

CLI は thin client とする。

- DB を直接読まない。
- object file を直接読まない。
- 復号鍵を持たない。
- runtime Memory API 経由で append / file usage / export を実行する。
- `append` の structured request は `--stdin` / `--file` を正本にする。
- `get-file` / `export-files` は明示 output path / output directory を必須にする。
- `file-usage` は target 指定なしで WithMate 全体使用量を返せる read-only command とする。
- `file-usage --largest --limit N` は容量整理候補を entry 単位で返すが、file path、object store path、key material、hash は返さない。
- Memory Review の export は renderer に output path や object metadata を返さず、entry id と exported count のみを返す。

project / character / user-global target を伴う object access は V6 Memory foundation の explicit target policy に従う。

## Forget And GC

`memory.forget` は Memory entry を通常 search から除外し、関連 file refs も inactive にする。

forget 処理:

1. target / permission を検証する。
2. entry を `forgotten` にする。
3. entry file refs を inactive にする。
4. ref count が 0 になった object を `delete_pending` にする。
5. DB transaction commit 後に encrypted object file を削除する。
6. 削除成功時は object を `deleted` にする。
7. 削除失敗時は `delete_pending` を保持し、GC retry 対象にする。

`privacy` reason では、entry text の縮退に加えて file ref summary / display name も縮退する。object metadata も通常 search / get-entry に出さない。

GC は Memory Review / 管理画面から実行できるようにする。agent-facing hard purge は初期公開しない。

GC の対象:

- `delete_pending` object
- DB ref がない orphan file
- metadata があるが file がない missing object の repair report
- staging file の cleanup

Memory Review から実行する GC は dry-run と cleanup を分ける。dry-run は DB / file system を変更せず、cleanup は `delete_pending` object の file delete 成功または既に missing の場合に metadata を `deleted` に進める。active metadata に紐づく object は削除対象にしない。orphan file / staging cleanup の renderer response は件数と bytes の summary に限定し、object store path、key material、hash は返さない。

## UI Policy

Memory Review / 管理画面に次を追加する。

- Protected Object 全体使用量
- quota / used / available / pending delete
- Memory file quota setting
- 容量の大きい Memory entry 一覧
- entry detail の file summary 表示
- explicit export action
- dry-run GC / cleanup GC
- delete pending / missing object の report

UI は runtime API secret、key material、object file path、復号済み temp path を renderer に渡さない。

## Security And Privacy

- file path は保存しない。
- original filename は必須にしない。
- search / get-entry / file-usage response に object store path を含めない。
- export は明示 output path だけに書く。
- `get-file` は既存 output file を上書きしない。
- target 外 object の存在確認に使える差分を agent-facing response へ出さない。
- `privacy` forget では file summary / display name も通常利用対象から除外する。
- runtime secret、key id 以外の key material、nonce misuse を log / audit に残さない。
- audit は mutation / export の operation、entry id、object id、status、reason、timestamp 程度に抑える。

## Failure Policy

- quota 超過は append 前に machine-readable error を返す。
- input file missing / unreadable は append 全体を失敗させ、partial entry を作らない。
- object write 成功後に import / DB transaction が失敗した場合、service は今回 prepare した object file を best-effort delete する。削除できず残った object は orphan として GC 対象にする。
- file 付き append の完了済み idempotent replay は import 前 replay preflight で再 import を避ける。
- 同一 idempotency key の並列同時送信で preflight 後に別 request が先に commit した場合、追加 object は orphan として GC 対象にする。将来は append idempotency reservation で import 前に concurrent duplicate を抑止できるようにする。
- DB commit 後の file delete 失敗は `delete_pending` として retry する。
- export 対象 file が missing の場合、entry / search は壊さず、export API は missing object error を返す。
- Memory API unavailable 時は既存 V6 foundation と同様に CLI が non-zero exit code と JSON error を返す。

## Alternatives

### SQLite BLOB に encrypted bytes を保存する

DB と file の整合は単純になるが、SQLite 本体と WAL が肥大化し、V3 blob storage で避けた問題を再導入するため採用しない。

### file path だけを Memory に保存する

容量は増えないが、元 file の移動 / 削除で Memory が壊れ、privacy / portability / evidence preservation の目的を満たしにくいため採用しない。

### CLI が復号鍵を持つ

CLI 配布物や shell environment へ key material が広がり、WithMate runtime service 境界が崩れるため採用しない。

### 個別 file size limit を設ける

初期実装では `64 MiB` を固定上限にする。これは streaming 暗号化を入れる前の main process / runtime API 保護であり、WithMate 全体 quota とは別に append / export の読み込み前 validation で拒否する。将来 streaming read / encrypt / write へ移行した場合だけ、設定で optional per-file limit へ広げる。

## Risks

| Risk | Mitigation |
| --- | --- |
| Protected Object が storage を圧迫する | WithMate 全体 quota、append preflight、file-usage CLI、Memory Review 使用量表示 |
| 並列 append で quota を超える | storage service で quota reservation / transaction を扱う |
| file を開かないと削除可否が分からない | file 付き Memory の `body` と `files[].summary` を必須にする |
| file delete に失敗して容量が戻らない | `delete_pending` と GC retry を持つ |
| object path / key material が漏れる | renderer / CLI response / audit に path と key を出さない |
| encrypted object が missing で UI が壊れる | search / get-entry は summary-first、export だけ missing error |
| backup / restore が DB file だけでは不完全 | V6 Memory Protected Objects は DB と `memory-objects/v6/` を同じ永続化単位として扱う |

## Implementation Slices

1. Design / contract
   - Done: 本書を追加する。
   - Done: V6 Memory foundation / documentation map に supporting doc として参照を追加する。
   - Done: Settings で Memory file quota を設定できるようにする。
2. Schema / storage
   - Done: object metadata table と quota usage query を追加する。
   - Done: `forget` 成功時に active object metadata を `delete_pending` にする。
   - Done: `memory-objects/v6` object store の shard path、staging write、delete primitive を追加する。
   - Done: `AES-256-GCM` payload envelope helper を追加する。
   - Done: active data key を platform key protector で wrap する key store abstraction を追加する。
   - Done: `appendEntry` transaction 内で protected object metadata と quota preflight を扱う storage 境界を追加する。
   - Done: input file inspection、AAD生成、暗号化、object store write、storage登録用metadata生成を行う importer を追加する。
   - Done: application service で file 付き append の quota preflight、importer 実行、storage transaction 登録、失敗時の prepare 済み object cleanup を接続する。
   - Done: file 付き append の完了済み idempotent replay を import 前に判定する replay preflight を追加する。
   - Done: protected object metadata に `role` を保存し、既存 metadata には `other` を backfill する。
   - Pending: entry ref table を追加する。
   - Pending: import 前 idempotency reservation による concurrent duplicate orphan 削減を追加する。
   - Done: Memory Review 用 GC report を追加する。
   - Pending: key rotation を追加する。
3. Service / contract
   - Done: `file-usage` を application service に追加する。
   - Done: `file-usage --largest --limit N` 用の entry 単位容量候補を追加する。
   - Done: `memory.append` request contract に `files[]` を追加し、`files[].summary` 必須 validation を追加する。
   - Done: `memory.append` の file 実体保存を application service で有効化する。
   - Done: search / get-entry / append response に復号不要の file summary hydration を追加する。
   - Done: `role` 付き file summary hydration を追加する。
   - Pending: object 再利用に備えた entry ref table を追加する。
   - Done: `get-file` を application service に追加し、明示 output path への復号 export を接続する。
   - Done: `export-files` を application service に追加し、entry 内 active object の一括 export を接続する。
   - target / permission / existence oracle 防止を既存 V6 Memory service に合わせる。
4. CLI
   - Done: `file-usage` を追加する。
   - Done: `file-usage --largest --limit N` を追加する。
   - Done: `append` structured files input を実体保存へ接続する。
   - Done: `get-file` を追加する。
   - Done: `export-files` を追加する。
5. UI
   - Done: Memory Review entry detail に file summary を表示する。
   - Done: Memory Review に usage と largest entries を表示する。
   - Done: Memory Review に export、GC を追加する。
6. Validation
   - quota exceed、append atomicity、forget cleanup、delete pending retry、path non-exposure、target mismatch、missing object fallback を test する。
   - Done: Memory Review export response が path / object id / key material / hash を renderer に出さないことを test する。
   - Done: GC dry-run / cleanup が delete_pending、orphan file、staging file を summary report に畳み、active object を削除対象にしないことを test する。

## Validation Strategy

- contract validation: file 付き append で `body` / `files[].summary` が必須であること。
- quota test: quota 超過時に entry も object も作られないこと。
- storage test: encrypted object roundtrip、hash mismatch、missing file report。
- service test: target mismatch object が `not_found` になること。
- exporter test: encrypted object を復号して明示 output path へ書き、既存 file を上書きしないこと。
- exporter test: 複数 encrypted object を output directory へ安全な file name で書き出すこと。
- forget test: entry forget で ref が inactive になり、unreferenced object が delete されること。
- delete pending test: file delete 失敗時に retry 対象として残ること。
- CLI test: `file-usage` が path / key material を返さないこと。
- CLI test: `file-usage --largest --limit N` が runtime API query 経由で entry 単位候補を取得し、path / key material / hash を返さないこと。
- CLI test: `get-file` が runtime API 経由で明示 output path を渡し、path / key material をresponseへ含めないこと。
- CLI test: `export-files` が runtime API 経由で明示 output directory を渡し、path / key material をresponseへ含めないこと。
- UI / IPC test: renderer に object path、key material、hash、復号済み temp path が渡らないこと。
- GC test: dry-run が DB / file system を変更しないこと、cleanup が delete_pending と orphan / staging のみを対象にすること。

## Open Questions

- key storage の platform abstraction をどの層に置くか。
- encrypted object に圧縮をかける場合、圧縮対象と順序を content type ごとに変えるか。
- `rawSha256` を保存するか、dedupe を延期して ciphertext hash のみにするか。
- `file-usage` を target 別にも返すか、初期は WithMate 全体だけにするか。
