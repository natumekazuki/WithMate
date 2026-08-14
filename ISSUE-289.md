# Character Affect の未処理評価が回復ループに滞留する

## 状態

- 種別: 不具合調査・修正
- 優先度: 高
- 対象バージョン: WithMate 6.3.21
- 証拠取得日時: 2026-08-13 10:38 JST

## 問題

Character Affect の評価に失敗した項目が回復キューに残り続け、バックグラウンド評価の起動と警告ログの出力を繰り返している。失敗が項目単位で収束しないため、通常のセッション実行と同じ provider プロセスやローカル資源を継続的に消費する可能性がある。

未処理データを失わずに原因を特定し、再試行可能な失敗は収束させる。恒久的に成功しない項目は、他の項目や通常のセッション実行を妨げない状態へ隔離する。

## 確認できた事実

利用者環境で取得したログは本Issueへ添付しない。以下は、2026-08-13 10:38 JST時点の集計と、調査に必要なレコードだけをマスクして転記した証拠である。開発環境から利用者環境のファイルを参照する必要はない。

取得時点の1,606件のうち、次の警告が大半を占めていた。

- `character-affect.lifecycle.settlement-pending`: 847件
- `character-affect.lifecycle.recovery-failed`: 416件
- `character-context.lifecycle.read-failed`: 2件

`character-affect.lifecycle.settlement-pending` はすべて `code: storage_unavailable`、`retryable: true`、`effect: none` だった。`character-affect.lifecycle.recovery-failed` の主な例外は、15秒後に子プロセスを中断した `AbortError` だった。

代表レコードを次に示す。セッションIDは同じ値の対応関係を保ったまま仮名化し、製品のインストール先を含むstackは削除している。

```jsonl
{"appVersion":"6.3.21","level":"warn","kind":"character-affect.lifecycle.settlement-pending","process":"main","message":"Character affect appraisal remains pending","data":{"sessionId":"<session-A>","code":"storage_unavailable","retryable":true,"effect":"none"},"timestamp":"2026-08-13T01:31:43.802Z"}
{"appVersion":"6.3.21","level":"warn","kind":"character-affect.lifecycle.recovery-failed","process":"main","message":"Pending Character affect appraisal remains available for recovery","data":{"sessionId":"<session-B>"},"error":{"name":"AbortError","message":"The operation was aborted","stack":"<redacted: child_process aborted by AbortSignal timeout>"},"timestamp":"2026-08-13T01:31:58.930Z"}
{"appVersion":"6.3.21","level":"warn","kind":"character-context.lifecycle.read-failed","process":"main","message":"Character context was unavailable for a session turn","data":{"sessionId":"<session-C>","code":"storage_unavailable","retryable":true,"conversationMayContinue":true},"timestamp":"2026-08-13T00:47:09.721Z"}
```

利用者環境のV6データベースを読み取り専用で集計した結果は次のとおりだった。レコード本文は取得していない。

```json
{
  "character_affect_turn_settlements": {
    "pending": 57,
    "settled": 134,
    "pendingBreakdown": [
      {
        "ready": true,
        "evaluationPersisted": false,
        "lastEffect": "none",
        "count": 57,
        "minimumAttemptCount": 1,
        "maximumAttemptCount": 508
      }
    ]
  },
  "character_affect_events_v6": {
    "count": 156
  }
}
```

起動時ログでは、V6データベースのスキーマ診断は正常で、Memory V6 Runtime APIも起動に成功している。現時点では、データベース全体の破損やRuntime APIの起動失敗を示す証拠はない。

```jsonl
{"appVersion":"6.3.21","level":"info","kind":"app.database.selected","process":"main","message":"App database selected","data":{"compatibilityMode":"v6","schemaVersion":6,"userVersion":6,"exists":true,"schemaValid":true,"runtimeCompatible":true,"valid":true,"warnings":[]},"timestamp":"2026-08-13T00:14:14.964Z"}
{"appVersion":"6.3.21","level":"info","kind":"memory-v6.runtime-api.started","process":"main","message":"Memory V6 runtime API started","data":{"published":true,"addressFamily":"IPv4","createdDatabase":false,"dbPath":"<redacted>","discoveryFilePath":"<redacted>"},"timestamp":"2026-08-13T00:14:16.326Z"}
```

関連する現在の実装は次のとおり。

- `src-electron/main.ts` の `settleCharacterAffectTurn` は、評価用provider処理のタイムアウトを15秒に固定している。
- `src-electron/character-affect-turn-drain.ts` は、ready状態の未処理項目を順番に処理する。
- `src-electron/character-affect-turn-retry-scheduler.ts` は、未処理項目がある限り回復処理を再スケジュールする。
- `src-electron/character-context-application-service.ts` は、想定外の例外を `storage_unavailable` へ変換する。この変換後のエラーには元例外の種類や処理段階が残らない。

## 利用できない原資料

利用者環境の生ログとデータベースは提供しない。上記のマスク済みレコードと集計値を初期証拠とし、開発環境ではfixtureまたは新たに追加する診断情報によって再現する。生ログの追加提供を着手条件や完了条件にしない。

## 未確認の点と仮説

根本原因はまだ確定していない。少なくとも次の二つの失敗経路が混在している。

- Character Context の取得中に例外が起き、`storage_unavailable` として返る経路
- Context取得後のバックグラウンド評価が15秒以内に終わらず、`AbortError` になる経路

未処理項目のユーザーメッセージは最大17,637文字で、検索語は最大454個だった。長い入力から生成したMemory検索クエリや評価プロンプトが失敗時間を延ばしている可能性はあるが、現時点では因果関係を確認できていない。

再試行回数が項目ごとに増えても、項目単位の次回実行時刻や停止状態を持たないことが、ログと負荷の増幅要因になっている可能性が高い。

## 調査内容

- [ ] `storage_unavailable` へ変換する前の例外について、処理段階、例外名、安全に記録できるメッセージ、所要時間を診断ログへ残す。
- [ ] Context取得を Affect状態取得、Memory検索、レスポンス組み立てに分け、どの段階で失敗しているか確認する。
- [ ] fixtureまたは開発環境で生成した未処理項目について、入力長、検索語数、provider、model、試行回数と失敗種別を相関させる。本文、workspace path、秘密情報は診断ログへ出さない。
- [ ] 長いユーザーメッセージを使ったMemory検索と評価プロンプトを分離して再現し、15秒の内訳を計測する。
- [ ] provider処理がタイムアウトしたとき、子プロセスと関連資源が確実に終了しているか確認する。
- [ ] 回復処理が通常のセッション実行、providerの同時実行数、アプリ終了処理へ与える影響を確認する。
- [ ] 上記集計の成功済み134件と未処理57件の差から検証可能な仮説を作り、fixtureで条件を絞る。利用者環境の各レコードを直接読むことは前提にしない。

## 修正方針を決める際の条件

調査結果に基づき、少なくとも次の性質を満たす再試行契約を定める。

- 一時的な失敗は、同じ相関IDと冪等性キーを維持して再試行できる。
- `effect: none` の項目を再試行しても、Affectイベントや関連Memoryを重複保存しない。
- 部分成功または結果不明の項目は、保存済み範囲をread-backしてから続行する。
- 失敗した一項目が、キュー内の他項目を継続的に妨げない。
- 再試行間隔、最大試行回数、隔離後の復旧方法を明示する。
- タイムアウト値を変更する場合は、単なる延長ではなく、実測した通常時間と異常時の資源占有時間を根拠にする。
- 未処理項目を自動で破棄しない。破棄が必要な場合は、対象条件とデータへの影響を別途判断する。

永続キュー、外部provider呼び出し、冪等性、並行処理へ影響するため、実装前に `contract-closure` のPre-Implementation Closure Planを作成する。再試行方針や永続状態を変更する場合は、ADRの要否も判定する。

## 完了条件

- [ ] 根本原因を、再現結果または処理段階を特定できる診断証拠で説明できる。
- [ ] 修正後、新規のCharacter Affect評価が正常にsettledへ到達する。
- [ ] 一時的なContext取得失敗とproviderタイムアウトを再現し、定めた再試行契約どおりに遷移する。
- [ ] 恒久的に失敗する項目があっても、他項目と通常のセッション実行が進行する。
- [ ] 同一項目に対するAffectイベントとMemory episodeの重複が発生しない。
- [ ] 警告ログが無制限に増えず、未処理件数、試行回数、次回試行または隔離状態を診断できる。
- [ ] 更新版を利用者環境へ適用した後、既存pendingを回復または隔離できる診断・運用手順が用意されている。実データへの適用自体は本Issueの開発完了条件に含めない。
- [ ] 関連するtargeted test、型検査、最終差分に対する必要範囲の回帰検証が成功する。

## 検証候補

- `scripts/tests/character-affect-turn-settler.test.ts`
- `scripts/tests/character-affect-turn-drain.test.ts`
- Character Affect retry schedulerの項目単位バックオフと隔離を検証するテスト
- 長い入力に対するMemory検索と評価タイムアウトの再現テスト
- `npm run typecheck`
