# Provider Usage Telemetry

- 作成日: 2026-03-25
- 対象: coding provider の quota / context usage を WithMate UI に表示するための telemetry 設計

## Goal

provider ごとの使用状況を WithMate で観測し、Session Window から必要最小限の usage 情報を確認できるようにする。

第 1 slice は `GitHub Copilot` を対象にする。

## Scope

- app 全体で共有する provider quota telemetry
- session ごとに持つ provider context telemetry
- Main Process memory cache と IPC 契約
- Session Window の最小 UI

## Out Of Scope

- DB 永続化
- Home に詳細 usage dashboard を常設すること
- Codex 側の quota / reset 可視化
- billing 設定や budget 操作

## State Model

usage telemetry は `global` と `session` の 2 層に分ける。

### Global Provider Quota

`Premium Requests` は provider account 単位の状態なので、session とは独立した shared state に置く。

```ts
type ProviderQuotaSnapshot = {
  quotaKey: string;
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
};

type ProviderQuotaTelemetry = {
  provider: "copilot";
  updatedAt: string;
  snapshots: ProviderQuotaSnapshot[];
};
```

第 1 slice では `copilot premium requests` 相当の snapshot が主対象だが、複数 quota key を保持できる形にして固定しすぎない。

### Session Provider Telemetry

`Context Usage` は会話文脈ごとの状態なので、session 単位で持つ。

```ts
type SessionContextTelemetry = {
  provider: "copilot";
  sessionId: string;
  updatedAt: string;
  tokenLimit: number;
  currentTokens: number;
  messagesLength: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
};
```

session local telemetry は Main Process memory のみで保持し、session close や app restart で消えてよい。

## Source Mapping

### Copilot

`Premium Requests` は次の 2 経路で更新する。

- 初期取得
  - `client.rpc.account.getQuota()`
- 実行中更新
  - `assistant.usage.data.quotaSnapshots`

`Context Usage` は次の event を使う。

- `session.usage_info`

current の `CopilotAdapter` は `assistant.usage` の token 数だけを使い、`session.usage_info` は drop している。第 1 slice では telemetry 用に保持する。

### Codex

第 1 slice では未対応。

理由:
- current `@openai/codex-sdk` は turn usage token 数しか返さない
- quota remaining / reset を取るには別 REST 経路が必要

## Update Timing

### Global Quota

`Premium Requests` は app 全体で共有し、次のタイミングで更新する。

1. Home または Session から Copilot 情報が初めて必要になった時
   - `getQuota()` を 1 回呼ぶ
2. Copilot turn 開始時
   - cache が stale なら background refresh
3. Copilot turn 中
   - `assistant.usage.quotaSnapshots` を受けたら即時更新
4. ユーザー明示 refresh
   - 将来追加余地。第 1 slice では必須にしない

quota は session ごとに取り直さず、Main Process 側の shared cache を renderer に配る。

### Session Context

`Context Usage` は session ごとに次のタイミングで更新する。

1. Copilot turn 中
   - `session.usage_info` を受けるたび更新
2. turn 完了後
   - 最後の値をそのまま保持
3. session 切替時
   - 対象 session の telemetry を表示する

session open 直後に値がまだ無い場合は empty state でよい。

## Cache Policy

- global quota cache は Main Process memory に置く
- session context cache も Main Process memory に置く
- DB 保存はしない
- global quota には短い stale 判定を持たせる
  - 例: 5 分
- `assistant.usage.quotaSnapshots` が届いた場合は stale 判定を待たず上書きする

## IPC Contract

renderer からは `listSessions` と同じく snapshot + subscribe で扱う。

```ts
type WithMateWindowApi = {
  getProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  getSessionContextTelemetry(sessionId: string): Promise<SessionContextTelemetry | null>;
  subscribeProviderQuotaTelemetry(
    listener: (providerId: string, telemetry: ProviderQuotaTelemetry | null) => void,
  ): () => void;
  subscribeSessionContextTelemetry(
    listener: (sessionId: string, telemetry: SessionContextTelemetry | null) => void,
  ): () => void;
};
```

第 1 slice では provider id は実質 `copilot` 固定でもよいが、shared contract は provider-neutral にしておく。

## Session Window UI

### Premium Requests

Session Window では `Latest Command` の下に、最小の quota strip を置く。

- 常時表示する情報
  - provider label
  - `remaining`
- 補足表示
  - hover / details / 小さな副表示で `used / entitlement / reset`

第 1 slice の primary copy 例:

- `Premium Requests 72%`
- `Premium Requests 120 / 420 left`

どちらを主表示にするかは実装時に調整してよいが、`残量が一目で分かる` を優先する。

### Context Usage

`Context Usage` は default で非表示に寄せる。

- 常時表示しない
- 小さい `Context` toggle または `details` summary だけ置く
- 開いた時だけ
  - `currentTokens / tokenLimit`
  - `messagesLength`
  - 必要なら `systemTokens / conversationTokens`

つまり右 pane の常設面積は

- `Latest Command`
- `Premium Requests` の薄い strip
- `Context` toggle 1 行

までに抑える。

## Error / Empty State

- Copilot quota 未取得
  - `Premium Requests unavailable`
- session context 未取得
  - `まだ context usage はないよ。`
- provider が Copilot 以外
  - 第 1 slice では表示しない

## Persistence Policy

- usage telemetry は session DB / audit log へ保存しない
- telemetry は operational UI のための transient state として扱う
- audit は既存どおり token usage と transport payload を保存する

## References

- `docs/design/provider-adapter.md`
- `docs/design/desktop-ui.md`
- `docs/plans/archive/2026/03/20260325-rate-limit-surface-survey/result.md`
