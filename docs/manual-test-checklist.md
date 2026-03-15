# 実機テスト項目表

## 目的

- Electron 実行時の現行機能を人手で確認するためのチェックリスト
- 現時点で実装済みの UI / 永続化 / ランタイム挙動のみを対象にする
- pending 機能は含めない

## 更新方針

- ユーザーが触れる挙動を変更した場合は、この項目表を同じ論理変更単位で更新する
- 設計変更時は `docs/design/manual-test-checklist.md` と `docs/adr/001-manual-test-checklist-policy.md` の方針に従う
- 追加した項目は、実装済み機能の再現手順と期待結果が読める粒度で書く

## 前提

- `npm install` 済み
- 実機確認は Electron で行う
- 起動コマンド:

```bash
npm run electron:start
```

## テストデータ準備

- Git 管理下の作業用 workspace を 1 つ用意する
- Diff 確認用に、その workspace で
  - 新規ファイル追加
  - 既存ファイル編集
  - 既存ファイル削除
  が発生する依頼を用意する

## 項目

| ID | 領域 | 手順 | 期待結果 |
| --- | --- | --- | --- |
| MT-001 | Home 起動 | `npm run electron:start` でアプリを起動する | Home Window が表示される |
| MT-002 | Home 一覧 | session が 0 件の状態で起動する | 空状態メッセージが表示される |
| MT-003 | Characters 一覧 | character が 0 件の状態で起動する | 空状態メッセージと `Add Character` が表示される |
| MT-003a | Characters 検索 | Characters の検索入力に name または description の一部を入れる | 部分一致で character card が絞り込まれる |
| MT-003b | Characters 検索空状態 | 一致しない文字列を Characters の検索入力へ入れる | character 0 件とは別に「一致するキャラはない」空状態が表示される |
| MT-004 | Settings overlay | Home の `Settings` を押す | Home 上に overlay が開く |
| MT-005 | Settings overlay | Settings overlay の `Close` を押す、または overlay 外を押す | Settings overlay が閉じる |
| MT-006 | System Prompt Prefix | Settings overlay の `System Prompt Prefix` を変更して `Save Prefix` を押す | 保存成功メッセージが表示され、再度開いても値が保持される |
| MT-007 | Model catalog export | Settings overlay から `Export Models` を押し、保存先を選ぶ | catalog JSON が保存される |
| MT-008 | Model catalog import | catalog JSON を変更して `Import Models` を実行する | import 成功メッセージが表示され、active catalog が切り替わる |
| MT-009 | Add Character 起動 | Home の `Add Character` を押す | Character Editor Window が create mode で開く |
| MT-010 | Character 作成 | Name / Icon / Description / `character.md` を入力して `Save` を押す | character が保存され、Home の Characters 一覧に表示される |
| MT-011 | Character 編集 | Home の character card を押し、Description または `character.md` を変更して `Save` を押す | Character Editor Window が開き、更新内容が保存され、再度開いても反映される |
| MT-011d | Character Editor モード切替 | Character Editor で `Profile` と `システムプロンプト` を切り替える | `Profile` では metadata が、`システムプロンプト` では `character.md` editor が広く表示される |
| MT-011e | Character Editor action bar | Character Editor を通常サイズと縦に小さいサイズで開く | `Save / Delete` が画面最下部の action bar に固定され、本文はその上だけスクロールする |
| MT-011f | Character Editor tabs 位置 | Character Editor を開く | `Profile / システムプロンプト` tabs は content カードの外に表示され、余計な背景レールがない |
| MT-011f-1 | Character Editor base color | Character Editor を開く | Home と同じ dark base で表示され、白基調の panel に戻っていない |
| MT-011f-2 | Character Editor accent color | Character Editor を開く | active tab / Save に `main`、preview と card 補助ラインに `sub` が使われる |
| MT-011g | Character Editor content 高さ | Character Editor の縦を大きくした状態で `Profile` と `システムプロンプト` を切り替える | content カードが空き領域を使い切り、`character.md` だけ不自然に低くならない |
| MT-011h | Character Editor character.md 比率 | Character Editor を縦に伸ばして `character.md` を開く | editor が content 高さに対して大きく広がり、footer との間に不自然な空白が残らない |
| MT-011i | Character Editor character.md 説明 | Character Editor の `システムプロンプト` タブを開く | `character.md` がキャラクター定義の正本であり、プロンプト合成に使われる説明と editor が同じカード内に表示される |
| MT-011j | Character Editor profile overflow | Character Editor の縦を小さくして `Profile` を開く | `Theme` を含む下部要素がカード内スクロールで収まり、カード外にはみ出さない |
| MT-011k | Character Editor preview fixed layout | Character Editor の縦を小さくして `Profile` を開く | top preview の avatar サイズと theme swatch 位置が変わらず、同じレイアウトを維持する |
| MT-011l | Character Editor profile scrollbar gutter | `Profile` タブでスクロールが必要な状態と不要な状態を切り替える | スクロールバーの有無で内部レイアウト幅が揺れない |
| MT-011a | Character Theme 編集 | Character Editor で `main / sub` color を color picker / hex / RGB 入力で変更して `Save` を押す | 保存後に再度開いても色が保持される |
| MT-011b | Home Character Theme 反映 | theme color を設定した character を Home で確認する | character card の背景に `main`、左アクセントに `sub` が使われ、文字が読めるコントラストで表示される |
| MT-011c | Character Editor 小ウインドウ | Character Editor を縦方向に小さくして開く | preview / form / role / action が崩れず、全体をスクロールして操作できる |
| MT-012 | Character 削除 | Character Editor Window で `Delete` を押して確認する | character が削除され、Home の Characters 一覧から消える |
| MT-013 | Character 画像 | Character Editor で画像を設定して保存する | Home の character card と Session の avatar に画像が表示される |
| MT-013a | App data path 固定 | Electron を起動して character または session を保存する | 保存先が `<appData>/WithMate/` 配下になり、`Electron/` 配下へ新規保存されない |
| MT-014 | New Session 起動 | Home の `New Session` を押す | launch dialog が開く |
| MT-014a | New Session title 初期値 | Home の `New Session` を開く | タイトル入力は空文字で表示される |
| MT-014b | New Session title 必須 | title 未入力のまま dialog を確認する | `Start New Session` は無効のまま |
| MT-015 | Workspace picker | launch dialog の `Browse` を押して directory を選ぶ | 選択した path が dialog に表示される |
| MT-015a | New Session approval 非表示 | Home の `New Session` を開く | approval 選択 UI は表示されず、session は `on-request` 固定で作成される |
| MT-015b | New Session character theme | Home の `New Session` を開く | character card が Home と同じ theme rule で表示され、背景に `main`、左アクセントに `sub`、文字は読めるコントラストになる |
| MT-016 | New Session 作成 | title と workspace と character を選び `Start New Session` を押す | Session Window が開き、Home の session 一覧に追加され、タイトル入力値が session title になる |
| MT-016b | Session base color | Session Window を開く | Home と同じ dark base で表示され、header / chat / composer / artifact が白基調に戻っていない |
| MT-016c | Session contrast | Session Window を開き、タイトル、approval 選択中、artifact の file path、Audit Log の各ラベルと本文を確認する | 背景色と同化せず、主要テキストと補助テキストが読み分けられる |
| MT-016a | Empty Session 表示 | 新規 session を作成してまだ送信しない | chat 履歴には初期 assistant メッセージが表示されない |
| MT-017 | New Session 制約 | character が 0 件の状態で `New Session` を開く | `Start New Session` は実行できず、character 作成導線が表示される |
| MT-018 | Session title rename | Session Window で `Rename` を押し、タイトルを変更して `Save` を押す | Session title が更新され、Home の一覧にも反映される |
| MT-019 | Session title cancel | Session Window で `Rename` 後に `Cancel` または `Escape` を押す | タイトル変更が破棄される |
| MT-020 | Session delete | idle 状態の Session Window で `Delete` を押して確認する | session が削除され、Session Window が閉じて Home 一覧から消える |
| MT-021 | Approval mode | Session Window の composer 下で approval を切り替える | 選択値が更新され、再度開いても保持される |
| MT-022 | Chat 送信 | Session Window の textarea に入力して `Send` を押す | user message が追加され、pending bubble が表示される |
| MT-022a | Streaming 表示 | command 実行を伴う依頼を送信する | pending bubble 内に assistant text と live activity step が逐次表示される |
| MT-022c | 複数 agent_message 連結 | provider が 1 turn で複数の `agent_message` を返す依頼を送信する | chat UI の assistant text が最後の 1 件で欠けず、arrival 順に連結されて表示される |
| MT-022b | Streaming 復元 | 実行中に Session Window を閉じてから同じ session を開き直す | 実行中の live activity が再表示される |
| MT-022d | Session 実行キャンセル | 実行中に composer の `Cancel` を押す | 実行が止まり、session は `idle` に戻り、assistant message にキャンセル通知が 1 件追加される |
| MT-022e | Session キャンセル監査ログ | 実行中に `Cancel` を押した turn の Audit Log を開く | 同じ turn record が `CANCELED` で残り、error にユーザーキャンセルが表示される |
| MT-022f | Session キャンセル partial 記録 | ファイル変更や agent_message が途中まで出た状態で `Cancel` を押す | Audit Log に partial response / operations / raw items が残り、chat の `Details` でも変更済みファイルが見える |
| MT-023 | ショートカット送信 | Session Window の textarea で `Ctrl+Enter` または `Cmd+Enter` を押す | 送信される |
| MT-024 | 改行 | Session Window の textarea で `Enter` 単体を押す | 改行され、送信されない |
| MT-025 | 実行中制御 | 実行中に textarea / model / depth / approval 変更を試す | 実行中に無効化されるべき操作が無効になっており、composer の主操作は `Send` ではなく `Cancel` に切り替わる |
| MT-026 | Model 選択 | Session Window の model select を変更する | 選択した model が保存される |
| MT-027 | Depth 選択 | Session Window の depth select を変更する | 選択した depth が保存される |
| MT-027a | Model 変更後実行 | thread を持つ既存 session で model を変更して送信する | model mismatch error にならず、新しい thread で実行される |
| MT-027b | Depth 変更後実行 | thread を持つ既存 session で depth を変更して送信する | reasoning 変更後も新しい thread で実行される |
| MT-027c | Session Theme 非反映 | theme color を設定した character で session を開く | Session Window の配色は neutral のままで、character theme を変えても bubble や主要 action の色は変わらない |
| MT-028 | Turn Summary | assistant message の `Details` を押す | changed files / checks / operation timeline が展開される |
| MT-028d | Turn Summary partial diff | canceled または failed の turn で `Details` を押す | 実行結果が異常終了でも、その時点までの file diff があれば表示される |
| MT-028c | Turn Summary agent_message 流れ表示 | `command_execution` と複数の `agent_message` を含む turn で `Details` を開く | コマンドや reasoning だけでなく `agent_message` も同じ timeline に入り、応答の流れを追える |
| MT-028a | Rich Text 表示 | inline code / list / markdown link を含む assistant message を表示する | 生テキストの塊ではなく、rich text として読みやすく表示される |
| MT-028b | Rich Text リンク | `[label](absolute-path-or-url)` を含む assistant message をクリックする | URL かローカルパスが既定の方法で開く |
| MT-029 | Diff overlay | `Open Diff` を押す | Session Window 内に Diff overlay が開く |
| MT-030 | Diff popout | Diff overlay で `Open In Window` を押す | Diff Window が別ウインドウで開く |
| MT-031 | Diff split 表示 | add / edit / delete を含む turn で Diff を開く | `Before / After` の split diff が表示される |
| MT-032 | Diff 縦スクロール同期 | Diff Viewer の片側を縦にスクロールする | 反対側も追従する |
| MT-033 | Diff 横スクロール同期 | 長い 1 行を含む diff で片側を横にスクロールする | header / body と左右ペインが追従する |
| MT-034 | Session 永続化 | session を作成してアプリを終了し、再起動する | Home の一覧に session が残る |
| MT-034a | Recent Sessions 表示 | Home の session card を確認する | `taskTitle`、`Workspace : <path>`、`updatedAt: yyyy/MM/dd HH:mm` が表示され、待機 badge と task summary は表示されない |
| MT-034d | Home Session Theme 反映 | theme color を設定した character の session を Home で確認する | session card の背景に `main`、左アクセントに `sub` が使われ、文字が読めるコントラストで表示される |
| MT-034b | Recent Sessions 検索 | Home の検索入力に title または workspace の一部を入れる | `taskTitle / workspace` の部分一致で chip と card が絞り込まれる |
| MT-034c | Recent Sessions 検索空状態 | 一致しない文字列を検索入力へ入れる | session 0 件とは別に「一致するセッションはない」空状態が表示される |
| MT-035 | Running chip | 実行中の session を Home に戻って確認する | `running` chip に表示され、再度開ける |
| MT-036 | Close protection | 実行中の Session Window を閉じる | 確認ダイアログが出る |
| MT-037 | Close and continue | 実行中の close 確認で `閉じて続行` を選ぶ | Session Window は閉じるが、アプリは終了せず処理が継続する |
| MT-038 | Quit protection | 実行中にアプリ終了を試みる | 終了確認が出る |
| MT-039 | Interrupted recovery | 実行中にアプリを強制終了して再起動する | 対象 session が `interrupted` として復旧し、Home に chip 表示される |
| MT-040 | Interrupted resend | `interrupted` session を開き、`同じ依頼を再送` を押す | 直前の user message が再送される |
| MT-041 | Catalog 反映 | model catalog を import 後に新規 session を作る | active catalog の default model / depth が session に反映される |
| MT-042 | Catalog 反映 | 既存 session を開いたまま model catalog を import する | 既存 session の model select / depth chip が active catalog の候補に更新される |
| MT-043 | Audit Log 表示 | Session Window の `Audit Log` を押す | 監査ログ overlay が開く |
| MT-043a | Audit Log 折りたたみ | Audit Log を開く | `Input Prompt` だけ開いた状態で始まり、他の prompt / response / operations / raw items はカテゴリ単位で閉じた状態から必要なものだけ開ける |
| MT-044 | Audit Log 成功記録 | 1 回送信して成功させる | 1 turn につき 1 レコードだけが表示され、phase は `DONE` になる |
| MT-045 | Audit Log 内容確認 | 成功した監査ログを開く | system prompt / input prompt / composed prompt / response / operations / usage / raw items が確認できる |
| MT-045a | Audit Log と chat の応答一致 | 複数の `agent_message` を含む turn の監査ログを開く | `Response` は chat UI と同じ連結結果を表示し、個別の `agent_message` は `Operations` または `Raw Items` で追える |
| MT-046 | Audit Log 失敗記録 | provider 実行が失敗する条件で送信する | 1 turn につき 1 レコードだけが表示され、phase は `FAIL` になり、error が確認できる |
| MT-047 | 添付 picker | Session Window の `File` / `Folder` / `Image` を押す | 選んだ対象が attachment chip として表示される |
| MT-047a | 添付 picker 初期位置 | session を開いて最初に `File` か `Image` を押す | picker が workspace directory を開く |
| MT-047b | 添付 picker 再開位置 | 一度 file か image を選んだ後でもう一度 picker を開く | 最後に選んだファイルがある directory から開く |
| MT-048 | `@path` 解決 | textarea に `@src/App.tsx` のようなパスを書いて待つ | attachment chip に解決結果が表示される |
| MT-049 | 添付エラー | 存在しない `@path` を入力する | エラーが表示され、`Send` が無効になる |
| MT-050 | 画像添付送信 | image を添付して送信する | 送信が成功し、監査ログの input / composed prompt に画像参照が残る |
| MT-051 | 外部ファイル参照 | workspace 外の file / folder を添付して送信する | 送信が成功し、対象参照を含む依頼が処理される |

## 補足

- catalog が不正でも、アプリは自動補正しない
- catalog 上は有効でも provider 側で拒否された場合は session error として扱う
- `Character Stream` は現行 UI に含まれないため、項目表には含めない
