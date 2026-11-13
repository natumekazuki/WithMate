# Sessionの選定方針とWorktree配置

端末共通のProvider／Model選定基準、実行設定の目安、契約経路の利用方針と、Git Worktreeの配置ルールを保存します。Codex・Copilot・Claude・OpenCodeの通常Sessionから、Session MCPとbound CLIで同じ内容を扱えます。GUIの設定画面はありません。

## 通常作業での参照

子Session作成前、または既存Sessionへ送る次Turnの実行設定を選び直す前に、`session.get_selection_policy`を読みます。実際の選択肢は宛先ProviderとWorkspaceの`session.get_catalog`から取得し、Model Availabilityを含む制約に従います。必要なら`session.get_provider_quota`で既存の利用枠観測も確認します。

方針は判断材料であり、自動選定・実行許可ではありません。既存SessionのProviderは固定です。`enqueue`のModel／Depth／権限は当該次Turnだけへ適用され、`steer`は実行中Turnの設定を維持します。Roleによる作成権限、Characterの自動選定、個別操作の承認は変更しません。

Worktreeを新しく用意する直前には`session.resolve_worktree`へ対象repositoryのWorkspaceとbranch名を渡します。既存Worktreeの利用と新規作成候補を区別し、Git操作・base branch・作成先の占有・Workspaceの適否を別途確認します。照会自体はGitや設定を変更しません。

## 操作

MCP名は`session.<操作名>`です。CLIは同名のアンダースコアをハイフンへ置換します。どちらも起動中WithMateの通常Session bindingと実行中Turnが必要で、背景実行やunbound管理者モードには公開しません。正確な入力・出力schemaと説明は`withmate-session schema`から取得できます。

| 操作 | 内容 |
| --- | --- |
| `get_selection_policy` | 保存済み方針を取得。`policy: null`は未設定 |
| `set_selection_policy` | `policy`全体を登録・置換。`null`で解除 |
| `get_provider_quota` | 既存cacheのquotaを読取。`provider`省略で4Provider |
| `get_worktree_policy` | 端末rootと対象repositoryのルールを取得 |
| `set_worktree_root` | 絶対`rootPath`を登録・置換。`null`で解除し、repository別ルールは保持 |
| `set_worktree_repository` | 対象repositoryの`rule`全体を登録・置換。`null`でそのルールのみ解除 |
| `resolve_worktree` | `branch`の既存Worktreeまたは作成先候補を取得 |

`workspacePath`はGit repositoryを指定する操作で省略でき、その場合は実行元SessionのWorkspaceを使います。別repositoryを指定しても、その操作の対象になるだけでSessionのWorkspaceは変わりません。

## 恒久設定と単発指示の境界

設定操作は、ユーザーが恒久的な方針の登録・変更・解除を指示した場合だけ使います。「今回だけ深い推論を使う」「この作業だけ別の配置先を使う」、作業結果、評価やAgentの改善提案を恒久設定へ自動反映しません。通常のルールでは参照タイミングを案内し、登録・更新を促しません。外部のProvider管理ルールファイルもWithMateから書き換えません。

指示本文の判定器や追加承認機構は設けず、既存の権限とAgentの操作契約に従います。保存方針の変更は既存Sessionの保存設定、受付済み要求、実行中Turnを変更しません。

### 選定方針の入力例

以下は設定内容の形式例で、同梱の推奨値や利用可能性の保証ではありません。

```json
{
  "policy": {
    "selectionCriteria": "期待する成果と判断の難しさからProviderとModelを選ぶ。Roleだけでは固定しない。",
    "executionGuidelines": "不確実な判断には深いDepthを検討する。ApprovalとSandboxは依頼の許可範囲に従う。",
    "contractRoutes": [
      {
        "name": "Codex subscription",
        "provider": "codex",
        "conditions": "対象の契約枠と取得状態を確認して使う。"
      },
      {
        "name": "OpenAI API through OpenCode",
        "provider": "opencode",
        "nativeProviderId": "openai",
        "conditions": "従量課金経路の利用を許可された場合のみ。Modelは実catalogから選ぶ。"
      }
    ]
  }
}
```

`contractRoutes`の配列順が優先順です。`nativeProviderId`と`modelId`は任意で、OpenCodeの特定経路・Modelを指す場合に指定します。`modelId`はnative側のModel IDを表し、OpenCodeのcatalogでは`<nativeProviderId>/<modelId>`として照合します。API keyや認証情報は保存しません。catalogへの掲載、名前の`Free`表記、別経路の残量だけから、無料・利用可能・利用許可済みと判断しません。

### Quotaの読取

`get_provider_quota`はremote取得を開始せず、既存cacheの`telemetry`を返します。未観測は`null`、`updatedAt`は最終成功日時で成功前は`null`です。`status`の`loading`／`ready`／`error`／`unsupported`と、`snapshots`／`rateLimits`の数値・窓・resetを保持します。件数方式のProviderでは成功時の`status`が省略される場合があります。

古い成功値と`error`は最新成功ではありません。不明・空・未対応を使用量ゼロ、残量100%、無制限へ読み替えません。OpenCodeの観測はOpenCode Go枠であり、他native接続先の残量へ流用しません。契約と実行経路の違いは[Provider Usage Telemetry](../design/provider-usage-telemetry.md)を参照してください。

## Worktreeの配置

端末rootの例は`{"rootPath":"C:/user/GitWorktree"}`、repository別ルールの例は次のとおりです。

```json
{
  "rule": {
    "categoryPath": "Electron",
    "repositoryName": "WithMate",
    "layout": "{repository}/{branch}"
  }
}
```

この例で`feat/issue-938`の新規候補は`C:/user/GitWorktree/Electron/WithMate/feat/issue-938`です。`categoryPath`は`.net/MAUI`のように階層を持てます。既存の綴り`ChromeExtentions`などをそのまま設定でき、空文字列は分類directoryを置かない明示指定です。`repositoryName`は単一directory名、`layout`は`{repository}`と`{branch}`を含む相対配置です。絶対指定・親への遡り・不正なdirectory名は拒否します。

repositoryの識別には実体のGit common directoryを使います。同じrepositoryのlinked Worktree間で設定を共有し、同じremoteを持つ別cloneとは分けます。repository本体を移動してcommon directoryが変わった場合は、新しい場所に対してルールを設定してください。

`resolve_worktree`の返却は次の3状態です。

- `existing`／`source: git`: branchをcheckoutしている登録済みWorktreeを返します。root／ルールが未設定でも利用でき、単発指定より優先します。
- `planned`／`source: policy`または`override`: 保存ルール、または明示した一時的な絶対`destinationPath`から新規候補を返します。候補は作成済み・空き状態の保証ではありません。単発指定は保存しません。
- `unconfigured`: `missing`に`rootPath`／`repositoryRule`を示し、`destinationPath`は`null`です。Session Folder／Crew Folderへのfallbackはありません。

## 保存と解除

既存`app_settings`に`session_selection_policy_json`と`worktree_policy_json`としてStorage Workerが保存します。未設定の読取で既定方針を生成せず、不正な保存値も既定値へ置換しません。通常のAppSettings更新で保持し、アプリ設定の全体resetでは両方とも解除されます。認証・quota実測・Git Worktree自体はこの設定に保存しません。既存tableを使うためschema migrationは不要です。
