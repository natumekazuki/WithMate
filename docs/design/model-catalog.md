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

## Model Availability

Modelとnativeサービスの無効設定は、SDK一覧と分離した`AppSettings.modelAvailability`へWithMate providerごとに保存する。`disabledModelIds`は完全なmodel ID、`disabledServiceIds`はnativeサービスIDを保持する。app共通設定であり、workspaceや認証contextには依存せず、未設定はすべて有効とする。明示された不正な保存値を既定値へ置き換えない。

OpenCodeのサービスIDはmodel IDの最初の`/`より前とする。サービスの無効化は配下のModel全体に適用し、一覧へ新しく追加されたModelにも及ぶ。サービスを再有効化しても個別Modelの無効設定は保持する。他providerには仮のサービス階層を作らない。

Settingsの管理画面は無効なModelも表示し、通常のModel選択肢は無効なサービス・Modelを除外する。保存済みの現在値とDepthは変更せず、現在値の表示は維持するが候補へ再挿入しない。pickerは開いた時点の無効なModelも含むSDK候補・定義をsnapshotとして保持し、表示時にだけ最新の無効設定を適用する。開いている間の無効化では候補を隠し、再有効化では同じsnapshotの候補を戻す。SDK一覧のbackground更新によるsnapshotの差し替えとは分けて扱う。

新規要求の受付とMain／Auxiliary共通の実行開始前に、最新の設定でModelを検査する。保存済み・選択中のIDも例外とせず、無効なら実行前に拒否する。queue待機中に無効化された要求は開始前に失敗とし、実行中turnは停止しない。同じrequest IDの既知receiptの再取得には新規送信の検査を課さない。新規Sessionが引き継ぐ選択値や既定Modelも検査し、無効なら別Modelへfallbackしない。

背景三用途のModel候補にも同じ無効設定を適用する。保存済みのModel／Depthは保持し、無効な現在値は選択不能な表示として残して修正先を案内する。背景呼出しの開始準備で最新設定を検査し、無効なら`unavailable`として開始しない。別Modelへのfallbackや、設定変更による準備済み・実行中の呼出しの取消は行わない。

無効設定の検査自体はローカルの設定だけに対して行い、SDK一覧の再取得や掲載確認は要求しない。背景処理など呼出し固有のcatalog検証とは分離する。MCP経由の要求にも同じ受付・実行境界を使い、Model一覧・指定用のMCP API自体はこの設定機能に含めない。

## Model UI

- 共通ComposerのModelは検索付きpopoverとし、Depthは独立した選択のままにする。providerやsortの追加UIは置かない。
- 通常順は表示名の自然順昇順（数値を数値として比較）とし、同名は配信元、IDの順で安定化する。選択中modelにはcheckを表示する。
- 検索は表示名／IDの完全一致、前方一致、部分一致、配信元だけの一致の順で並べ、同順位では通常順を使う。候補の主行はモデル名、補助行はnative配信元のprovider IDだけを表示し、配信元がなければ補助行を省く。完全なモデルIDは検索と候補のtitleで参照できる。portalのスクロールバーも呼出元の共通theme tokenを使う。
- 大量候補はvirtualizeする。開いている一覧はModel／Depth定義を含むsnapshotとして安定させ、background更新で候補が動かないようにする。選択確定はその候補の定義と確定時の現在Depthから解決し、更新後の一覧への掲載を条件にしない。cacheなしで開いた場合だけ最初の取得成功を反映し、検索文字列とfocusを維持したまま候補を表示する。取得中、取得失敗、正常empty、検索0件は区別する。再openで開始した取得の状態は候補の固定と独立して反映し、先着した新しい通知やworkspace切替後の状態を遅い応答で巻き戻さない。
- keyboardの矢印／Page移動、Enterで選択、Escapeで取消、focus復帰を提供し、IME変換中のEnterを選択として扱わない。

## OpenCodeのmodelと認証

model IDは`<native provider>/<model>`とし、最初の`/`で分ける。残りの`/`はmodel IDに保持する。`opencode-go/...`、`opencode/...`、`openai/...`等を同じWithMate provider `opencode`内で扱い、Depthをnative variantへ渡す。`#variant`をmodel IDへ保存しない。native一覧で選択modelのenabled状態、variant、添付modalityを確認する。

一覧取得とturn実行は、PATH上の公式CLI `2.2.5`と同梱`@opencode/client` `2.2.5`を使い、既存native DB・global／project設定・API key／OAuth・起動元環境変数を同じstandalone経路で解決する。

CLIの`--version`をDBを開く前に照合し、異なる版では一覧取得・実行を止める。新しい版で使用済みのDBのdowngradeは行わない。

WithMate所有の`serve --stdio` processを使い、既存の共有serviceへ接続したり、それを変更・停止したりしない。service専用のmanaged環境変数はstandaloneには適用されないため、必要な設定はWithMateの起動元環境またはOpenCodeのstandalone認証へ利用者が設定する。

一覧の取得は認証成功の確認ではない。WithMateはGo用keyを編集・注入せず、OAuth接続・credential import・アカウント切替UIも提供しない。WithMateにだけGo keyを登録していた利用者は、OpenCode側へ自分で登録する必要がある。保存済みkeyはOpenCodeへ自動移送せず、対象fieldだけを起動時に除去する。他providerのkey、有効化・Skill設定、会話とthreadは保持する。

利用時の設定手順は次のとおり。

1. WithMateの起動元から`opencode --version`を実行でき、対応版`opencode v2.2.5`であることを確認する。別versionのDBをこの版へdowngradeしない。
2. `opencode auth login --standalone`でGo・OpenAI等のAPI keyまたは対応するOAuth認証をOpenCodeへ登録する。登録済みの場合は再登録不要。環境変数で認証する場合はWithMateの起動元へ設定する。
3. WithMateのSettingsでOpenCodeを有効化し、Sessionで対象のnative modelを選ぶ。認証の更新・期限切れへの対応もOpenCode側で行い、次の接続・通常の一覧再取得へ反映する。

保存済み会話の継続では、WithMate専用DBを使う公開済みSessionのraw thread IDを保持し、旧DBからrootと全childを公式export／importで既存native DBへ取り込む。旧DBを読む場合だけ同梱CLI `2.2.5`を使い、credentialは移さない。成功後は`native:<ID>`参照を保存する。native DBの取り違え、owner不一致、未解消pending、active thread、移行・再開の失敗では送信せず明示エラーにし、新規threadへfallbackしない。旧DBは保持する。詳細は[Thread Management](provider-adapter.md#thread-management)を参照する。

## 保存境界

公開済みSessionの`catalog_revision`列の値は保存互換性のため保持するが、renderer、現在選択、送信要求、adapterの実行条件には使わない。V6 schema更新では手管理catalogの3 tableを削除し、Session・会話・draft・最小turnは保持する。詳細は[Database Schema](database-schema.md)を参照する。

## 関連

- [Provider Adapter](provider-adapter.md)
- [Electron Session Store](electron-session-store.md#実行設定と-send)
