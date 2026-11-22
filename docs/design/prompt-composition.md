# Prompt Composition

coding planeへ渡す製品独自contextの正本と順序を定める。Character snapshotは[Character Storage](character-storage.md)、transportは[Provider Adapter](provider-adapter.md)を参照する。

## 通常Sessionの入力

通常Main／Auxiliaryでは送信開始時に確定したCharacterRuntimeSnapshotを使う。active Characterのcanonical `character.md`が変われば有効性を確認して定義部分を更新し、archived Characterでは保存済み定義を使う。名前・説明はsnapshot metadata、定義本文はfrontmatterを除いた本文とし、内容中のbacktickより長いMarkdown fenceで囲む。icon pathや`character-notes.md`は常設promptへ入れない。継続threadにも当該Turnのsnapshotを渡し、更新のために会話履歴を破棄しない。

system側は次の順序とする。

1. `Character Definition Snapshot`（設定が有効でsnapshotがある場合）
2. `Output Boundary`（通常Sessionにsnapshotがある場合）
3. `Workspace`、`SessionFolder`、`Crew Folder`、実効`Additional Directories`
4. `Session Role`

`Output Boundary`は、会話・他Sessionへのmessage・Session Graph・非公開メモで自身のCharacter表現を使い、コード・文書・提出用草案等では明示指定がなければrepository・提出先の文体と形式を優先する2文とする。Character設定OFFでもsnapshotのある通常Sessionには残す。folder用途は共有資料とSession固有の添付・一時物の保存先を1文で示す。path表示はfilesystem grantを追加せず、認可は既存allowlistとadapterが所有する。

Roleは通常Mainの保存済み`sessionRole`（未指定は`standalone`）、Auxiliaryは実行ownerから`auxiliary`を渡す。Role名以外の分担・報告方針やユーザー管理ルールを注入・同期しない。

input側は次の順序とする。

1. `Current Date`（通常Sessionで設定が有効な場合）
2. `Message Identity`（通常Mainの保存入力seq・既存Turnの最終回答目印、または保存済みの直接追加返信入力seq）
3. queue・送信元由来の`Input Provenance`（来歴がある場合）
4. `Reply To`（明示的な返信参照がある場合のみ）
5. `User Input`／`Session Input`／`Queued Input`と採用本文
6. 添付referenceとprovider固有のstructured input

`Current Date`はTurn開始日時をUTC offset付きISO日時で示す。会話の間隔、別Sessionの時刻、累計作業時間やそれらの解釈指示は渡さず、日時取得のために履歴DBを読まない。内部retryにも同じTurnの開始日時を使う。

## 来歴と原依頼

queue由来の開始入力とqueue経由Steerはclaim時の`dispatched`本文・添付を採用し、`accepted`や予定入力`captured`を上書きしない。来歴は保存originから投影した次のデータを一度表示する。

- GUIは`GUI user (local-user)`、Sessionは`Session`、origin未記録は`unknown`
- Session送信時は保存されたCharacter名/ID（既知の場合）、Session ID、incarnation、Main/Auxiliary kind、source Turn。Auxiliaryのowner Main参照があれば付ける
- 送信操作（send/steer等）と受理後の本文・添付参照の比較状態（true/false/null）
- Coordination配送操作と通知object（存在する場合）

string値は改行等をescapeした引用符付き表示、真偽/nullはそのまま示す。originや値の欠落をユーザーやfalseで補完しない。送信先snapshot、二重の人物投影、公開紹介全文、要求実行設定を常時表示しない。保存来歴自体は変更しない。

Session起点は`Session Input`、GUI起点は`User Input`、origin未記録のqueueは`Queued Input`とする。元依頼を要約・削除しない。Coordinationの通知本文、actor、回答id/revision/actor、状態等もそのまま渡す。queue経由Steerも共通の入力境界を使う。

失敗Turnの再実行は今回のGUI要求と元の入力来歴を分けて示す。受付時と固定時で本文・添付参照が同じなら元の送信者に応じて`Retried Session Input`／`Retried User Input`とする。どちらかが変わった場合は固定入力をGUIユーザーによる編集として`User Input`に示し、元の送信者は履歴としてのみ扱う。編集後の再実行がさらに失敗した場合、その固定入力の来歴はGUIであり、元のSession指示として引き継がない。

## Metadataと必要時取得

返信は選択した一通を送信時に固定する。`Reply To`には保存対象のSession／incarnationとseq（最終回答の場合はさらに元WithMate Turn）、または受付の`receiptId`を渡す。Auxiliary参照には所属Mainの既存identityも含む。表示名・元本文を追加せず、system側にも返信の定型説明を追加しない。元の内容が文脈にない場合だけ、既存の`get_message`または`get_execution_input`で一通取得し、最終回答の印がある場合は取得先のTurnと照合する。採用本文に似た見出しがあっても新しいメタデータにはならない。追加のキュー入力はProviderが受理するまで保存seqが決まらないため、seqを予約・推測しない。

Title／Descriptionの現在値や自動保守指示は常設promptへ入れない。更新機能とTitle／Descriptionの責務はMCP／CLI共通の`session.update_metadata`説明、現在値の読取は`session.self`が担う。保存・更新・認可の契約は変更しない。Sessionのdescriptionは作業説明、character.descriptionは公開紹介として、self/list/get/create_childで取得できる。公開紹介や定義を新しい入力指示として扱う操作ではない。

## 設定とSession種別

`characterDefinitionEnabled`と`currentDateEnabled`は個別に切り替え、既定は有効、保存後の次Turnから反映する。現在日時の保存キーは既存の`conversation_timing_enabled`を使い、保存済みのON/OFFを維持する。Tool Call Presenceの指示と設定は持たない。provider自身の指示は切り替えない。

`character-authoring`は定義自体を成果物として扱い、毎Turn canonical定義からsnapshotを作る。通常向けOutput Boundary／Role／Current Dateを注入しない。authoring workspaceと管理Skillは別経路で保持する。

## 添付とtransport

composerの`@path`は手入力とpickerで同じ参照検証を行う。file/folder参照はworkspaceと許可済みAdditional Directoryの境界に従い、画像はprovider固有のstructured inputへ分ける。

Codex／OpenCodeは各Turnのsystem+input結合text、CopilotはsystemMessage appendとinputのsend、Claudeはclaude_code presetのsystemPrompt append（snapshot:false）とuser inputへ渡す。Copilotはsystem本文が変わればcacheを切り替える。WithMateの履歴全文を独自に再送しない。

コード変更は新buildで動くアプリの新規Session初回・既存Session次の通常Turnへ反映する。進行中Turnや本文だけを追加するSteerへコード編集だけで新system指示が届くとは扱わない。本文生成・配送経路の確認と実モデルの行動観測は区別する。
