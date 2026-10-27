# Provider Model Discovery

## 正本と責務

Model候補とDepthはCodex、Claude、GitHub Copilot、OpenCodeのSDK／native model一覧から取得する。WithMateは選択肢をSQLiteへcacheするが、手管理のmodel定義、同梱JSON、import／export、catalog revisionによる実行許可は持たない。

`ProviderCodingAdapter.listModels()`がprovider固有の取得・正規化を担い、`ProviderModelDiscoveryService`が取得の開始、cacheの選択、状態通知を所有する。Sessionのproviderは作成時に固定し、Model UIはそのproviderの候補だけを表示する。OpenCodeのnative配信元はmodel IDに含まれ、WithMateのprovider切替ではない。

## Cacheと更新

- storage Workerが`provider_model_cache`を所有する。主キーは`provider_id / context_key`、payloadは`provider_json`、取得時刻は`fetched_at`に保存する。
- contextはprovider、絶対workspace path、provider設定、関連する認証環境変数で分離する。credentialを含む入力はMain内でdigest化し、rendererのsnapshotへcontext keyやcredentialを渡さない。
- UIは該当contextのcacheを先に表示する。10分以上古いcacheまたは未取得の一覧は、Modelを開いたときにbackgroundで取得する。同contextの実行中取得はまとめ、通常の再試行は30秒間隔とする。取得には20秒のabort timeoutを設ける。
- 起動時とprovider設定変更時は有効なproviderをbackgroundで取得する。設定変更前の応答を新contextへ保存せず、storage lifecycle終了時は取得をabortして完了を待つ。
- `idle / loading / ready / error`と取得時刻を通知する。失敗時は同contextの既存cacheを保持し、失敗を正常emptyや別contextの候補へ置換しない。専用のrefresh操作は設けない。

## 選択と実行

候補の更新は選択肢の更新であり、Session migrationではない。保存済み・現在選択のmodel／Depth、入力draft、thread、実行中turn、受付済みqueueの捕捉値は変更しない。cacheから消えた現在のmodelも表示を維持する。

新規会話はproviderごとの現在選択、なければ保存済みの直近値を引き継ぐ。どちらにもmodelがない場合、同contextのcacheに既定modelがあれば背景更新の失敗後も利用する。cacheがなければ初回一覧を待ち、取得したprovider defaultを使う。一覧取得に失敗した場合は固定modelや別contextへfallbackしない。

Sendはその時点のmodel、Depth、権限等を`executionOptions`へ捕捉し、Main／Auxiliaryの実行と最小turn記録へ同じ値を渡す。非空modelと入力形式・権限はMainの境界で検証し、SDK一覧への掲載やrevisionを実行の条件にしない。providerが拒否したmodel／Depthは実行エラーとして扱い、別model、Depth、providerへ自動切替しない。

Depthはmodelがadvertiseする任意文字列の配列であり、固定enumに限定しない。空配列はDepthなしを表し、UIを隠す。候補がある場合は空文字の`Default`も表示し、nativeへのDepth未指定と表示を一致させる。明示的なmodel変更では、新modelで現在のDepthを使える場合は維持し、使えなければそのmodelのdefaultまたは未指定へ変更する。候補のbackground更新だけではDepthを変更しない。

## Model UI

- 共通ComposerのModelは検索付きpopoverとし、Depthは独立した選択のままにする。providerやsortの追加UIは置かない。
- 通常順は表示名の自然順昇順（数値を数値として比較）とし、同名は配信元、IDの順で安定化する。選択中modelにはcheckを表示する。
- 検索は表示名／IDの完全一致、前方一致、部分一致、配信元だけの一致の順で並べ、同順位では通常順を使う。名前に加え、識別に必要な配信元とIDを表示する。
- 大量候補はvirtualizeする。開いている一覧はsnapshotとして安定させ、background更新で候補が動かないようにする。cacheなしで開いた場合だけ最初の取得成功を反映し、検索文字列とfocusを維持したまま候補を表示する。取得中、取得失敗、正常empty、検索0件は区別する。再openで開始した取得の状態は候補の固定と独立して反映し、先着した新しい通知やworkspace切替後の状態を遅い応答で巻き戻さない。
- keyboardの矢印／Page移動、Enterで選択、Escapeで取消、focus復帰を提供し、IME変換中のEnterを選択として扱わない。

## OpenCodeのmodelと認証

model IDは`<native provider>/<model>`とし、最初の`/`で分ける。残りの`/`はmodel IDに保持する。`opencode-go/...`、`opencode/...`、`openai/...`等を同じWithMate provider `opencode`内で扱い、Depthをnative variantへ渡す。`#variant`をmodel IDへ保存しない。native一覧で選択modelのenabled状態、variant、添付modalityを確認する。

一覧の取得は認証ではない。SettingsのGo keyはGo用であり、ChatGPT OAuthの代替ではない。keyが空でも通常turnを一律拒否せず、native側の認証・設定に従う。native DBはWithMateのuser data・build channel別に分離し、別DBを使うOpenCodeデスクトップ版のログインを自動共有しない。WithMate内のOAuth接続・credential import・アカウント切替UIは提供しない。

## 保存境界

公開済みSessionの`catalog_revision`列の値は保存互換性のため保持するが、renderer、現在選択、送信要求、adapterの実行条件には使わない。V6 schema更新では手管理catalogの3 tableを削除し、Session・会話・draft・最小turnは保持する。詳細は[Database Schema](database-schema.md)を参照する。

## 関連

- [Provider Adapter](provider-adapter.md)
- [Electron Session Store](electron-session-store.md#実行設定と-send)
