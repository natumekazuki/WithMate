# Prompt Composition

coding planeへ渡す指示の正本、順序、成果物境界を定める。Characterの表現はユーザー向け自然言語レスポンスへ反映し、ファイル操作、権限、repository instruction、検証結果の正確さを置き換えない。Character snapshotは[Character Storage](character-storage.md)、Memoryの権限と利用は[V6 Memory Foundation](v6-memory-foundation.md)、providerのtransportは[Provider Adapter](provider-adapter.md)を参照する。

## 通常Sessionの入力

通常Sessionでは作成時に保存した`CharacterRuntimeSnapshot`を使い、catalogの後続編集には自動追従しない。Character名と説明はsnapshot metadata、定義本文はfrontmatterを除いた`character.md`から取り、system側の`Character Definition Snapshot`として渡す。`character-notes.md`とMemory entryは常設promptへ入れない。

論理sectionは次の順序で構成する。存在しない値や無効化されたsectionの空見出しは残さない。

1. `Character Definition Snapshot`（有効なCharacter snapshotがあるとき）
2. `Output Boundary`（通常SessionにCharacter snapshotがあるとき）
3. `Tool Call Presence`（同条件で設定が有効なとき）
4. `Folder Context`（実行workspace、解決済みSessionFolder、実効Additional Directories）
5. `Character Affect Context`（取得でき、設定が有効なとき）
6. input側の`Conversation Timing`（通常Sessionで設定が有効なとき）
7. `User Input`とそのターンの本文
8. 添付referenceとprovider固有のstructured input

`Output Boundary`はCharacter設定をOFFにしてもsnapshotがある通常Sessionには残し、コード、設定、test、文書、commit message案、PR本文案、diff等の成果物へCharacter表現を混ぜない。`Tool Call Presence`は最初のtool call前の短い自然言語応答を求めるが、すべての操作の実況は求めない。`Folder Context`は値を示すだけでfilesystem grantを拡張せず、認可は既存allowlistとprovider adapterが所有する。

`Conversation Timing`はturn開始時に固定した観測値を`User Input`直前へ置き、会話のペースの弱いシグナルとして扱う。別Sessionの内容や生活状況を推測しない。`Character Affect Context`はread projectionであり、生event全体、Memory検索結果全体、secretを含めない。Affectのfamily集約とsession layerの時間減衰はCharacter Context側が所有する。

## 設定とSession種別

`AppSettings`の`characterDefinitionEnabled`、`characterAffectContextEnabled`、`conversationTimingEnabled`、`toolCallPresenceEnabled`は個別に対象sectionを切り替える。欠損した既存保存値では既定の`true`を使い、保存後の次turnから反映する。AffectとTimingをOFFにした通常Sessionでは、それぞれのturn開始時resolverも呼ばない。Affectのturn後の評価・保存やprovider自身の指示は、このforeground設定では切り替わらない。

`character-authoring` Sessionは`character.md`と`character-notes.md`自体を成果物として編集する。turn開始時にcanonical `character.md`からsnapshotを作り直す一方、通常Session向けの`Output Boundary`、`Tool Call Presence`、Affect、Timingは注入しない。authoring workspaceと管理Skillの指示は別経路として保持する。

## 添付と監査

composerの`@path`は手入力とpicker入力を同じ参照として検証する。通常file／folderの参照はworkspaceと許可済みAdditional Directoryの境界に従い、画像はprovider固有のstructured inputへ分ける。

監査では`logicalPrompt`のsystem、input、composed textと、providerへ実際に渡した`transportPayload`を分けて保存する。画像やCopilotの`systemMessage`等の別送情報を、論理表示だけから実transportと同一だと推定しない。[Audit Log](audit-log.md)は取得・表示の境界を定める。
