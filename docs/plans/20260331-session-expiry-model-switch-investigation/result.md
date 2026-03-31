# Result

## Status

- 状態: 調査完了寄り
- 実装: 未着手
- クローズ条件: main agent が issue / backlog 更新と follow-up 切り出し方針を確認できれば research task として閉じやすい状態

## 結論

- `#24` と `#32` は別症状ではあるが、first-class には同じ session resume / provider thread lifetime クラスタとして扱うべき
- 最も有力なのは、失効または非互換になった provider session/thread に対して stale `threadId` を再利用し、その失敗を recover できていないこと
- `#24` には加えて、Codex の model-switch resume 非互換が乗っている可能性が高い

## もっともありそうな原因仮説

1. **provider session/thread expiry 仮説**
   - long-idle 後に provider 側 session/thread lifetime を超え、既存 `threadId` の resume が `NotFound` になる
   - `#32` の主仮説であり、`#24` でも stale `threadId` が露出している可能性がある
2. **Codex の model-switch resume 非互換仮説**
   - model switch 後も同じ `threadId` を保持して `resumeThread()` すると、thread 作成時 model と整合しない resume が拒否される
   - `docs/design/provider-adapter.md` の reset 方針と current 実装のズレが、この仮説を補強する
3. **failure 後の recovery 不足仮説**
   - current runtime には `NotFound / expiry / invalid-thread / model-incompatible` 専用の error taxonomy や stale `threadId` invalidation がない
   - そのため 1 回の失敗が、そのまま継続不能な UX になる

## 推奨方針

1. **error taxonomy と stale `threadId` recovery を先に定義する**
   - `NotFound / expiry / invalid-thread / model-incompatible` を判別し、該当時は `threadId` を捨てて新規 session/thread へ回復する
2. **provider ごとに model switch policy を再決定する**
   - Codex は model switch 時 reset を第一候補にする
   - Copilot は実測までは断定せず、resume 可否を観測して policy を決める
3. **telemetry / audit を強化する**
   - provider 名、model、resume / create 分岐、raw error class、invalidated reason を残して `#24` と `#32` を観測可能にする
4. **必要なら暫定安全策で両 provider の model switch 時 reset を入れる**
   - 本修正までの user-facing 回避策として有効
   - ただし Copilot の継続性を不必要に落とす可能性があるため、恒久策ではなく暫定案として扱う

## `#24` と `#32` の扱い

- `#32` は long-idle 後の session expiry / recovery 不足を測る基準ケース
- `#24` はその基準ケースに対し、「model switch が stale `threadId` を露出させたのか」「Codex 固有の model-switch 非互換があるのか」を切り分けるケース
- そのため backlog 上は同一クラスタとして結びつけつつ、実測 task は分けてよい

## Follow-Up 実装候補

- session runtime に provider-neutral な resume error taxonomy を追加する
- stale `threadId` invalidation + 1 回だけ新規 thread/session 再試行する recovery を追加する
- model switch policy を provider ごとに明文化し、design doc と runtime を一致させる
- audit log / telemetry に resume failure classification を追加する
- 必要なら暫定で `applySessionModelMetadataUpdate()` の `threadId` 維持方針を見直す
