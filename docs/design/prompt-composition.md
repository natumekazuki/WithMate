# Prompt Composition

coding planeへ渡す指示の正本、順序、成果物境界を定める。Characterの表現はユーザーへの応答と、手元で扱う人が読む自然文へ反映し、ファイル操作、権限、repository instruction、検証結果の正確さを置き換えない。Character snapshotは[Character Storage](character-storage.md)、Memoryの権限と利用は[V6 Memory Foundation](v6-memory-foundation.md)、providerのtransportは[Provider Adapter](provider-adapter.md)を参照する。

## 通常Sessionの入力

通常のMain／Auxiliaryでは送信開始時に確定した`CharacterRuntimeSnapshot`を使う。active Characterのcanonical `character.md`が前回snapshotから変わっていれば有効性を確認して定義部分だけを更新し、archived Characterでは保存済み定義を使う。Character名と説明は保存済みsnapshot metadata、定義本文はfrontmatterを除いた`character.md`から取り、system側の`Character Definition Snapshot`として渡す。継続threadにも当該turnのsnapshotを渡し、更新のためにthreadや会話履歴を破棄しない。`character-notes.md`とMemory entryは常設promptへ入れない。

Character metadataの投影は名前・説明に限り、iconのpathは常設promptへ含めない。画像情報はSession/UIのsnapshotに保持する。定義本文は内容中のbacktickより長いMarkdown fenceで囲む。

論理sectionは次の順序で構成する。存在しない値や無効化されたsectionの空見出しは残さない。

1. `Character Definition Snapshot`（有効なCharacter snapshotがあるとき）
2. `Output Boundary`（通常SessionにCharacter snapshotがあるとき）
3. `Tool Call Presence`（同条件で設定が有効なとき）
4. `Folder Context`（実行workspace、解決済みSessionFolder、Crew Folder、実効Additional Directories）
5. `Session Metadata`（自会話の保存済みTitle／Descriptionと短い保守指示）
6. `Character Affect Context`（取得でき、設定が有効なとき）
7. input側の`Conversation Timing`（通常Sessionで設定が有効なとき）
8. queue由来の`Input Provenance`（保存済みoriginと受付後の本文・添付変更有無）
9. `User Input`／`Session Input`／`Queued Input`とそのターンの採用本文
10. 添付referenceとprovider固有のstructured input

Characterの適用範囲と成果物境界は`Output Boundary`へ集約する。ユーザーへの応答に加え、Session Graphや手元の作業記録など、リポジトリに含めず外部へ提出・公開しない自然文にもCharacterの表現を使う。手元の記録でも要求・判断・作業・検証の主体、事実・条件・状態を保ち、ID、状態値、コマンド出力、正確な引用などを書き換えない。リポジトリに含めるものや外部へ提出・公開する成果物には、ユーザーが明示しない限りCharacterの表現を混ぜず、repository instruction、既存文体、対象の目的を優先する。`Output Boundary`はCharacter設定をOFFにしてもsnapshotがある通常Sessionには残る。`Tool Call Presence`は最初のtool call前の1〜3文の自然な応答と、長い作業で必要な経過・反応を求める。詳細な計画、定型の開始挨拶、操作ごとの実況やtoolが不要な応答への前置きは求めない。`Folder Context`は値を示すだけでfilesystem grantを拡張せず、認可は既存allowlistとprovider adapterが所有する。

`Conversation Timing`はturn開始時に固定した観測値を入力section群の直前へ置き、会話のペースの弱いシグナルとして扱う。別Sessionの内容や生活状況を推測しない。`Character Affect Context`はAffectのread projectionであり、生event全体、Memory本文・preview、secretを含めない。Affectのfamily集約、session layerの時間減衰とafterglowはCharacter Context側が所有する。

queue由来の通常開始とqueue経由Steerはclaim時の`dispatched`本文・添付を採用し、`accepted`や予定入力`captured`を上書きしない。Provider入力へ実送信元のMain／Auxiliary種別、会話・incarnation・Turn、送信操作と明示宛先を渡し、別Sessionの入力は`Session Input`として直接のユーザー要求から区別する。GUI由来は`User Input`、origin未記録は`Queued Input`とし、送信者を推測しない。受付時の本文・添付参照と採用入力の比較は変更あり／なし／比較不能として示し、編集者や生成prompt全体の履歴を推測しない。Coordinationには保存された配送操作も付ける。送信元metadataは権限を追加せず、古い原文を実行対象の本文へ混ぜない。4 Providerの通常開始は共通compositionを使用し、queue経由Steerも同じ入力境界表現を用いる。

通常Main／Auxiliaryのturn開始時には、ユーザー入力によるMemory検索を行わない。Memoryは会話Agentが必要と判断したときに既存MCP／CLIで検索・一覧・本文取得し、アプリが検索結果をpromptへ自動注入しない。公開`character_context.get`／CLI `context-get`の任意queryによる明示取得も、この能動取得の経路に含む。

## 設定とSession種別

通常Main／Auxiliaryの`Session Metadata`は、Turn開始時の自会話のTitle／DescriptionだけをJSONとして渡す。他Sessionの説明を常設注入せず、保存値を命令・Role・権限へ昇格させない。初回の依頼理解時と説明が実態に合わなくなった時に`session.update_metadata`で自己更新するよう案内し、毎Turnの保存・入力要求・専用生成Turnは設けない。更新後の値は次Turnの保存metadataから取得し、進行中のProvider contextを書き換えない。

`AppSettings`の`characterDefinitionEnabled`、`characterAffectContextEnabled`、`conversationTimingEnabled`、`toolCallPresenceEnabled`は個別に対象sectionを切り替える。欠損した既存保存値では既定の`true`を使い、保存後の次turnから反映する。AffectとTimingをOFFにした通常Sessionでは、それぞれのturn開始時resolverも呼ばない。通常turn内のMemory／Affect MCPの利用説明やprovider自身の指示は、このcontext設定では切り替わらない。

`character-authoring` Sessionは`character.md`と`character-notes.md`自体を成果物として編集する。turn開始時にcanonical `character.md`からsnapshotを作り直す一方、通常Session向けの`Output Boundary`、`Tool Call Presence`、Affect、Timingは注入しない。authoring workspaceと管理Skillの指示は別経路として保持する。

## 添付とtransport

composerの`@path`は手入力とpicker入力を同じ参照として検証する。通常file／folderの参照はworkspaceと許可済みAdditional Directoryの境界に従い、画像はprovider固有のstructured inputへ分ける。

画像やCopilotの`systemMessage`等の別送情報を、論理promptだけから実transportと同一だと推定しない。prompt、transport payload、raw eventの独立した重複保存は行わず、通常履歴には会話本文と表示に必要なartifactを保存する。

Claude Agentでは、system側の共通sectionをSDKの`claude_code` presetへ`append`し、`snapshot: false`でturnごとに現在のCharacter snapshotとAffect contextへ置き換える。過去のAffectを追記し続けたり、WithMateの会話履歴を全文再送したりしない。この方式ではSDKのprompt cache効率や過去のthinking保持が変わり得る。user側の共通sectionはそのturnの入力として渡し、Claudeのnativeな`CLAUDE.md`やSkill、MCP設定の読込経路は書き換えない。
