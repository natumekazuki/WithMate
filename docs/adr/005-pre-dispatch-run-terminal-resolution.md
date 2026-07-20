# ADR 005: Provider送信前のRun終端で未確定状態を同時に収束させる

- Status: Accepted
- Date: 2026-07-16

## Context

Run admissionは、`queued` Run、`preparing` Attempt、`pending` Dispatch、必要な`creating` ProviderBindingを、Provider I/Oより先にdurable commitする。Application Serviceがその後のProvider送信前にcancelまたは中断を確定すると、従来のRun terminal commandはRunとAttemptだけをterminal化した。BindingとDispatchは未解決のまま残り、open Binding制約によって同じSessionの次回admissionを拒否した。

Persistence Workerだけでは、`creating` Bindingの外部会話作成requestが未送信なのか、送信結果が不明なのかを判別できない。`dispatching` Dispatchについても、Providerが実行requestを受理した可能性をSQLiteだけから否定できない。一方、Application ServiceはProvider I/Oの呼び出し境界を所有しており、requestをまだ送っていない場合を証明できる。

Run、Attempt、Binding、Dispatch、terminal event、child resultを別々のcommandで収束させると、途中失敗で次回admissionを妨げる組合せが再び残る。

## Decision

`repository.run.terminal`に、Application Serviceが知っているProvider送信前の状態を表す`preDispatchResolution`を必須入力として加える。Workerは宣言をDB状態と照合し、Run terminal transactionの中で未確定状態も同時に収束させる。

- `not_applicable`: 未解決の`creating` Bindingまたは`pending` / `dispatching` / `ambiguous` Dispatchがない場合だけ許可する。
- `binding_creation_not_sent`: 外部会話作成requestが未送信であることをcallerが証明した場合に限り、`creating` Bindingを`conversation_start_not_sent`でinvalidated、`pending` Dispatchをabortedへ進める。
- `binding_creation_ambiguous`: 外部会話作成requestの受理有無を証明できない場合、Bindingを`conversation_start_ambiguous`でinvalidated、Dispatchをabortedへ進め、Runのexternal side effectを`unknown`へ単調更新する。
- `dispatch_not_sent`: Bindingはactiveだが実行requestが未送信の場合、`pending` Dispatchをabortedへ進める。persistent Bindingはactiveのまま維持し、ephemeral Bindingはterminal Runから再利用できないためinvalidatedへ進める。

`dispatching`または`ambiguous` Dispatchは、このcommandで未送信として処理せず、`not_applicable`でも受理しない。Provider受理の照合後に既存のDispatch resolutionを使い、`ambiguous -> accepted`の知識補正をRun / Attemptの終端より先に確定する。照合前のRunをterminal化する入口は設けない。

外部会話作成結果の`ambiguous`は`repository.binding.resolve`で受理しない。`repository.run.terminal`がBinding、Dispatch、Run、Attempt、terminal eventを一括して所有し、child RunではDelegationとChild Deliveryも同じtransactionで確定する。terminal transactionは、参照するBindingがRunと同じSessionに属し、Binding ProviderがSession Providerと一致する場合だけ更新する。ephemeral Bindingは作成元Attemptからの終端だけを許可する。

terminal transactionは、同じAttemptの未解決supplemental inputもBinding失効前に確定する。Provider送信前の`pending` Deliveryは`aborted(run_terminal_not_sent)`、送信intentをcommit済みの`dispatching` Deliveryは`ambiguous(process_unknown)`へ進める。これにより、terminal Runやinvalidated Bindingを参照する未解決Deliveryを残さない。

commandのexact replay fingerprintはcanonical JSONから生成し、object key順を意味の差として扱わない。意味が異なる再実行は`lifecycle_conflict`として拒否する。

## Alternatives

- Run terminal後にstartup repairを呼ぶ: 通常実行中の既知状態をcrash復旧へ委ね、次回admissionまで不整合を残すため採用しない。
- BindingとDispatchを専用commandで先に収束させる: Run terminal、child result公開、未確定状態の間に部分成功が生じるため採用しない。
- `repository.binding.resolve`でも外部会話作成の`ambiguous`を終端できるようにする: `repository.run.terminal`との呼び出し順によってterminal eventとchild resultの確定可否が変わるため採用しない。
- Workerが`creating` Bindingを常に未送信とみなす: response loss後の外部会話を見落とし、external side effectを`none`と誤記するため採用しない。
- 旧commandを互換経路として残す: 未解決状態を残す入口が存続するため採用しない。

## Consequences

- cancelまたは中断のcommit後に、同じSessionの次回admissionをstartup repairなしで再開できる。
- Application ServiceはProvider I/O境界の事実に基づいて`preDispatchResolution`を選び、未確認の送信結果を`not_sent`として宣言してはならない。
- terminal transactionが失敗した場合、Run、Attempt、Binding、Dispatch、supplemental input Delivery、terminal event、child resultはすべて変更前へrollbackする。
- `repository.binding.resolve`は外部会話IDを一意に証明できた`active`だけを確定し、外部会話作成が不明なままRunを終端しない。
- `ambiguous` Dispatchが残る間はSessionを次回admissionへ解放しない。既存外部実行との照合または知識補正を先に行う。
- 既存のstartup repairはcrash後のlocal収束に残るが、通常のProvider送信前終端を完了させる手段としては使わない。
- この契約は未リリースのCP1 repository APIを置き換える。旧fingerprintとの互換fallbackは持たない。
