# Product Direction

WithMateは、CodexとGitHub Copilotのcoding agentを、選択したCharacterと一緒に使うElectronアプリです。作業の正確さと操作可能性を土台に、Characterとの継続した対話体験を提供します。

## 製品の優先順位

1. workspace、session、実行状態、承認、差分、失敗と回復を正しく扱い、coding agentとして成立させる。
2. Characterの話し方や反応を作業体験へ反映しつつ、ファイル操作、検証結果、権限、repository instructionの正確さを損なわない。
3. MemoryとCharacter Affectで会話の継続性を支え、忘却・訂正・権限境界を守る。

Characterの表現は、情報を読む・判断する・操作するための視認性と到達性を犠牲にしない。作業結果とCharacterらしい応答の役割は[Prompt Composition](prompt-composition.md)の境界に従う。

## Coding agentの作業面

- 実行workspaceと再開対象のsessionを明示する。
- providerが対応するmodel、depth、approval、sandboxなどの実行設定を選択・確認できるようにする。
- 実行中の状態と必要な承認を見せ、完了後は変更ファイル、監査情報、差分を辿れるようにする。
- provider固有の機能は共通のSession UIへ適切に投影し、利用できない機能を存在するかのように見せない。

provider間の対応状況は[Coding Agent Capability Matrix](coding-agent-capability-matrix.md)、現在の画面構成は[Desktop UI](desktop-ui.md)を参照する。

## Characterと継続性

Characterはcatalogからsessionごとに選ぶ。通常sessionは開始時点のruntime snapshotを保持し、後のcatalog編集で既存会話の人格を暗黙に差し替えない。作成・編集はCharacter Editorで行い、Character authoringは専用の通常Sessionと管理されたSkillを使う。保存とsnapshotの境界は[Character Storage](character-storage.md)に記す。

Memoryは通常のturnへ常設注入せず、権限を持つagentが必要なときに検索・追加・忘却するlocal serviceとする。Affectも永続eventとread-time projectionを区別する。正本、権限、privacy、データ保護は[V6 Memory Foundation](v6-memory-foundation.md)と関連ADRに従う。

## UIの判断基準

HomeはsessionとCharacterの入口、Session Windowは会話と作業の中心、Settingsはapp共通設定を扱う。会話機能ごとに別のchat layoutを増やさず、modeやcapabilityによって必要な操作だけを出す。情報がないpaneを説明文で埋めず、error、validation、安全上必要な案内は残す。Window間の責務は[Window Architecture](window-architecture.md)に記す。
