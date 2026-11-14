# Product Direction

WithMateは、CodexとGitHub Copilotのcoding agentを、選択したCharacterと一緒に使うElectronアプリです。作業の正確さと操作可能性を土台に、Characterとの継続した対話体験を提供します。

## 製品の優先順位

1. workspace、session、実行状態、承認、差分、失敗と回復を正しく扱い、coding agentとして成立させる。
2. Characterの話し方や反応を作業体験へ反映しつつ、ファイル操作、検証結果、権限、repository instructionの正確さを損なわない。
3. Character定義、通常Sessionの保存履歴、Session GraphとRepository Glossaryをそれぞれの責務で使い、対話と作業の継続性を支える。

Characterの表現は、情報を読む・判断する・操作するための視認性と到達性を犠牲にしない。作業結果とCharacterらしい応答の役割は[Prompt Composition](prompt-composition.md)の境界に従う。

## Coding agentの作業面

- 実行workspaceと再開対象のsessionを明示する。
- providerが対応するmodel、depth、approval、sandboxなどの実行設定を選択・確認できるようにする。
- 実行中の状態と必要な承認を見せ、完了後は変更ファイル、操作結果、差分を辿れるようにする。
- provider固有の機能は共通のSession UIへ適切に投影し、利用できない機能を存在するかのように見せない。

provider間の対応状況は[Coding Agent Capability Matrix](coding-agent-capability-matrix.md)、現在の画面構成は[Desktop UI](desktop-ui.md)を参照する。

## Characterと継続性

Characterはcatalogからsessionごとに選ぶ。通常sessionはstable ownerと表示metadataを維持し、active Characterの有効な定義変更を次の送信開始時に反映する。同名Characterへの切り替えや、更新のための会話履歴・provider threadの破棄は行わない。作成・編集はCharacter Editorで行い、Character authoringは専用の通常Sessionと管理されたSkillを使う。保存とsnapshotの境界は[Character Storage](character-storage.md)に記す。

## UIの判断基準

HomeはsessionとCharacterの入口、Session Windowは会話と作業の中心、Settingsはapp共通設定を扱う。会話機能ごとに別のchat layoutを増やさず、modeやcapabilityによって必要な操作だけを出す。情報がないpaneを説明文で埋めず、error、validation、安全上必要な案内は残す。Window間の責務は[Window Architecture](window-architecture.md)に記す。
