# Session files と artifact

## 担当する能力

- file stat、list、mkdir、delete、move、copy
- bounded binary read、write
- artifact create、list、get、read、attach、detach、transfer、delete
- Workspace、SessionFolder、additional directory間の明示transfer

## 公開操作候補

### Session file

- `session.files.stat`
- `session.files.roots.list`
- `session.files.list`
- `session.files.mkdir`
- `session.files.delete`
- `session.files.move`
- `session.files.copy`
- `session.files.read_text`
- `session.files.write_text`
- `session.files.read_binary`
- `session.files.write_binary`

### Artifact

- `artifact.create`
- `artifact.list`
- `artifact.get`
- `artifact.read`
- `artifact.attach`
- `artifact.detach`
- `artifact.transfer`
- `artifact.delete`

file operationはpathを扱う低水準API、artifact operationはstable identity、owner、media kind、provenance、retentionを扱う高水準APIとする。renameは同一root内の`session.files.move`として表す。

## Identity-bound path

requestへ任意host absolute pathを渡さない。sourceとdestinationは次のhandleで指定する。

- Session ID
- root kind: SessionFolder、Workspace、allowed additional directory
- allowed directory ID
- relative path
- expected file identityまたはcontent revision

serviceは保存済みSessionとgrantからrootを解決する。`..`、absolute path、ADS、device path、symlink、junction escapeを拒否する。validation後からside effect直前までのidentity変化を検出する。

`session.files.roots.list`はactorが利用できるroot handleをgrant projectionから列挙する。返すのはallowed directory ID、kind、display label、許可capability、visibility revisionであり、host absolute pathは返さない。sourceとdestinationのhandleはこのprojectionまたは同じcanonical grant revisionから取得する。

## File operation

deleteはfileとempty directoryを既定とし、recursive deleteは別のexplicit optionとdeletion manifestを要求する。move、copyはsourceとdestination双方のgrant、size、quotaを検証する。

binary read／writeはbase64を巨大JSONへ載せる方式だけに固定しない。chunkまたはstream handleを採用し、per-chunk、per-file、per-operation、root storage budgetを検証する。hashとsizeをpublic resultへ返し、response loss後の内容同一性を確認できるようにする。

overwriteはexpected destination identityを要求する。存在しないtargetへのcreateと、既存targetへのreplaceをstrict unionで分ける。

## Artifact resource

artifactは少なくとも次を持つ。

- stable artifact ID
- owner root／Session／Work Item
- media kind、name、content type、size、hash
- file handleまたはmanaged blob reference
- source operation／execution／result revision
- created、archived、deleted event
- visibility grantとretention policy

attachはartifactをTurn、Work Item、result、Coordination Eventへ参照付けし、detachは参照だけを外してcontentを削除しない。transferはcontentを複製するかownershipを移すかを明示し、元参照の扱いをmanifestへ記録する。

## Delete と retention

artifact deleteはactive reference、external consumer、retention、legal／user holdを確認する。参照中contentを物理削除せず、retained projectionまたはtombstoneへ遷移する。Agentが自身の一時artifactを自律回収できることは維持する。

Session deleteはartifact manifestを取得し、transfer、archive、cascade deleteを明示する。SessionFolder全体を先に削除してartifact rowだけ残さない。

## 必要な schema と service

- allowed directory identityとfile handle contract
- grant-backed allowed root discovery projection
- file mutation idempotencyとidentity-bound replace primitive
- binary chunk／stream service
- artifact registry、event、reference table
- transfer／delete manifest
- storage budget integration
- Session、Work Item、Turn、result projectionへのartifact reference

## Migration

既存SessionFolder内fileを全件自動artifact化しない。既存message attachmentとartifact metadataだけをbaseline registryへ移行し、それ以外はfile APIで扱う。Agentが必要なfileを後からartifactとして登録できる。

## Direct validation

- traversal、symlink、junction、ADS、case差、同一identity置換をWindowsで検証する。
- validation後のsource／destination差し替えを検出する。
- copy／move／deleteの各failure pointで部分contentと誤projectionを残さない。
- exact size、chunk、aggregate storage budgetを検証する。
- response loss replayで同じfileを重複作成または二重移動しない。
- artifact attach／detach／transfer／deleteでreferenceとcontent ownerが一致する。
- Session deleteとartifact retentionが部分削除を起こさない。
- public projectionへabsolute private pathやsecret metadataを出さない。
- root discoveryがgrant外directoryを列挙せず、返したvisibility revisionをmutation admissionで再検証する。

## Review lens

- text APIとbinary APIで異なるcontainment実装を持っていないか
- path validationとopen／rename／delete間のTOCTOU
- recursive deleteの対象範囲
- artifact reference countとphysical content lifecycle
- cross-root transferによるvisibility拡張
