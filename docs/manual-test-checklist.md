# 実機テスト項目表

## 目的

- Electron 実行時の現行機能を人手で確認するためのチェックリスト
- 現時点で実装済みの UI / 永続化 / ランタイム挙動のみを対象にする
- `Character Stream` / monologue plane の未着手機能は含めない

## 更新方針

- ユーザーが触れる挙動を変更した場合は、この項目表を同じ論理変更単位で更新する
- 初回リリース前のため後方互換性は前提にせず、非互換変更後の復旧導線も確認対象に含める
- 追加した項目は、実装済み機能の再現手順と期待結果が読める粒度で書く

## 前提

- `npm install` 済み
- 実機確認は Electron で行う
- 起動コマンド:

```bash
npm run electron:start
```

## 項目

| ID | 領域 | 手順 | 期待結果 |
| --- | --- | --- | --- |
| MT-001 | Home 起動 | `npm run electron:start` でアプリを起動する | Home Window が表示される |
| MT-002 | Home 一覧 | session が 0 件の状態で起動する | 空状態メッセージが表示される |
| MT-003 | Characters 一覧 | character が 0 件の状態で起動する | 空状態メッセージと `Add Character` が表示される |
| MT-004 | Settings overlay | Home の `Settings` を押す | Settings overlay が開き、`System Prompt Prefix` / `Coding Agent Providers` / `Coding Agent Credentials` / `Model Catalog` / `Danger Zone` が見える |
| MT-004A | Settings provider row layout | Home の `Settings` を開いて `Coding Agent Providers` を確認する | provider 名が左、checkbox が右の row で揃って見え、どの provider を on/off しているか即判別できる |
| MT-005 | Settings copy | Settings overlay を確認する | `OpenAI API Key (Coding Agent)` が coding plane 用と読め、`Character Stream 用ではない` 補助文と future note が表示される |
| MT-006 | Compatibility note | Settings overlay を確認する | `初回リリース前のため後方互換性は考慮しない` と `DB 初期化で復旧する` 旨の note が表示される |
| MT-007 | Settings save | `System Prompt Prefix` または coding provider 設定を変更して `Save Settings` を押す | 保存成功メッセージが表示され、再度開いても保持される |
| MT-008 | Model catalog export | Settings の `Model Catalog` から `Export Models` を押す | catalog JSON が保存される |
| MT-009 | Model catalog import | Settings の `Model Catalog` から `Import Models` を実行する | import 成功メッセージが表示され、active revision が更新される |
| MT-010 | DB reset confirm | Settings の `Danger Zone` で `DB を初期化` を押す | confirm が出る |
| MT-011 | DB reset success | idle session のみ存在する状態で `DB を初期化` を実行する | sessions / audit logs / app settings / model catalog が初期状態へ戻り、characters は保持される |
| MT-012 | DB reset reject | 実行中 session がある状態で `DB を初期化` を実行する | reset が拒否され、実行中 session の完了またはキャンセルを促す |
| MT-013 | New Session 起動 | Home の `New Session` を押す | launch dialog が開く |
| MT-014 | New Session 作成 | title と workspace と provider と character を選び `Start New Session` を押す | Session Window が開き、Home の session 一覧に追加され、選んだ provider で session が作られ、approval 初期値は `安全寄り` になる |
| MT-014A | New Session provider availability | `Coding Agent Providers` で一部 provider を無効化した後に `New Session` を開く | launch dialog の provider 候補には enabled provider だけが出る。0 件なら empty state が出て `Start New Session` は disabled のままになる |
| MT-015 | Session 実行 | Session Window の textarea に入力して送信する | user message が追加され、pending と live activity が表示される |
| MT-015A | Copilot basic turn | provider を `GitHub Copilot` にした session を作成し、text-only の prompt を 1 回送る | assistant response が返り、Session が `idle` へ戻る。添付なしなら Codex と同じ Session UI で 1 turn 完了できる |
| MT-016 | Session 実行キャンセル | 実行中に `Cancel` を押す | 実行が止まり、session は `idle` に戻り、Audit Log に `CANCELED` が残る |
| MT-017 | Approval / Model / Depth | idle 状態の Session Window で approval / model / depth を変更する | approval は `自動実行 / 安全寄り / プロバイダー判断` で表示され、選択値が保存され、再度開いても保持される |
| MT-018 | Audit Log | Session Window の `Audit Log` を押す | 1 turn 1 record の監査ログが閲覧でき、approval 表示は provider-neutral wording になる |
| MT-018A | Copilot audit log minimum | Copilot session で 1 turn 実行後に `Audit Log` を開く | `system / input / composed prompt`、assistant text、provider metadata、raw session events が保存される。operations は command が無い turn では空でもよい |
| MT-018B | Copilot Details / Diff | Copilot session で file 変更を伴う turn を 1 回実行し、assistant bubble の `Details` を開く | `Changed Files`、`Run Checks`、`operationTimeline` が表示され、差分がある file では `Open Diff` から split diff を開ける |
| MT-019 | Diff | artifact の `Open Diff` を押し、必要なら `Open In Window` も押す | inline diff と Diff Window の両方で split diff が開く |
| MT-020 | Character persistence | character を作成 / 編集 / 削除する | `characters/` 相当の保存内容が Home と Session に反映される |
| MT-021 | Character editor title theme | Home から Character Editor を開く | header title の文字色が現在のキャラ `main` 色で表示される |
| MT-022 | Session theme accent | Session Window を開く | header title、assistant / pending bubble、composer settings、`Send / Cancel`、Details 展開後の artifact block に character theme の accent が反映され、`user-bubble` は neutral tone を維持する |
| MT-023 | Diff theme accent | Session から Diff を開く | `titlebar / subbar / pane header` に character theme の薄い accent が反映され、`Before / After` の文字が背景色に埋もれず読める |
| MT-023A | Session wide layout baseline | `1920x1080` 前後の幅で Session Window を開く | 上段に compact な `Top Bar`、中央に左右 2 分割、下段に `Action Dock` が表示される |
| MT-023B | Session splitter resize | wide desktop 状態で左右境界をドラッグする | message list 面と `Latest Command` pane の幅が追従し、極端に寄せても chat の最小可読幅と右 pane の最小幅を下回らない |
| MT-023C | Session action dock baseline | Session Window を開き、textarea / attachment / skill / approval / model / depth / `Send` の位置関係を見る | これらが左ペイン内ではなく下段 `Action Dock` にまとまり、expanded 時だけ full editor と設定群が表示される。`File / Folder / Image` は attachment group、`Skill` は別ボタンとして区別される |
| MT-023D | Session top bar compact | Session Window を開き、必要なら `More` を開閉する | `Top Bar` は 1 行の strip として表示され、常時は `title / Audit Log / More / Close` だけが見え、`Rename / Delete` は `More` 展開時だけ表示される |
| MT-023E | Session action dock compact/expand | idle で draft 空の Session Window を開き、draft preview 押下 / `Hide` / textarea focus を試す | 初期状態は compact で、draft preview または textarea focus で expanded に戻り、`Hide` で再度 compact にできる |
| MT-023F | Session action dock forced expand | retry banner、skill picker、`@path` 候補、blocked feedback のいずれかが出る状態を作る | その間は `Action Dock` が compact に落ちず、必要な操作要素が隠れない |
| MT-024 | Latest command running state | `command_execution` を含む run を実行する | 右 pane に実行中または直前の command 1 件だけが表示され、raw command、status、source が読める |
| MT-025 | Latest command terminal state | completed / failed / canceled の run をそれぞれ確認する | run 完了後も right pane に直近 run の最後の command が残り、status が terminal state に応じて変わる |
| MT-026 | Latest command visibility with assistantText | assistantText streaming と `command_execution` が同時にある run を実行する | pending bubble は本文だけを表示し、right pane は command 1 件だけを表示する。command 一覧が会話本文を押し流さない |
| MT-027 | Latest command pre-command empty state | run 開始直後でまだ `command_execution` が来ていない状態を観察する | pending bubble に実行中 indicator が出て、right pane は `最初の command を待っています。` の empty state を表示する |
| MT-028 | Live progress pending indicator persistence | run 開始直後から assistantText streaming 開始後まで pending bubble を観察する。可能なら本文と right pane が同時に見える run も確認する | 本文が出始めても `runState === "running"` の間は先頭の実行中 indicator が残り、character 名が取れる時は `<キャラ名>が…` の形、取れない時は主語なしの一般化表現で表示される。`runState !== "running"` になった時点で indicator が消える |
| MT-029 | Latest command details collapse | command output を伴う run を実行する | right pane では raw command が常時表示され、stdout / stderr 相当は `Details` を開いた時だけ見える |
| MT-030 | Latest command separation | assistant 本文と step 更新が両方ある run を実行する | `assistantText` が pending bubble 本文として表示され、right pane には command 以外の full timeline や `agent_message` 一覧を出さない |
| MT-031 | Latest command risk badge | 削除系 / 書き込み系 / network 系 command を含む run を観察する | right pane に `DELETE / WRITE / NETWORK` の rough risk badge が必要な時だけ出る |
| MT-032 | Latest command last-run fallback | run 完了後に Session を開き直す、または failed / canceled 後の session を再表示する | liveRun が空でも直近 terminal Audit Log から最後の command が復元され、right pane に表示される |
| MT-033 | Latest command error block | provider error または tool error を再現する | `liveRun.errorMessage` が right pane の command card 内 alert として表示され、command 本体と見た目が混線しない |
| MT-034 | Live progress no false step-running on completed-only steps | `assistantText` 未着のまま visible step が全件 `completed` になる run を観察する | pending bubble の実行中 indicator 自体は run 中なら残ってよいが、step 実行中ではない局面で `〜が作業を進めています` へ固定されたり、`コーディングエージェントがステップを実行中` と誤読させる copy にはならず、character 名ベースまたは一般化 fallback で現在の局面に沿う文言になる |
| MT-035 | Latest command failed without assistantText | `assistantText` 未着のまま failed run を発生させる | pending bubble の実行中表示と right pane の command / error block が競合せず、何が最後の command だったかを読める |
| MT-036 | Message list follow mode | long session で 80px を超えて上へスクロールして読み返し中にする。そのまま新着 assistant message / pending bubble 更新を発生させる。続けて assistantText streaming 中の run も観察する。最後に session を切り替える | 上スクロール中は位置が維持され、追従停止中は `新着あり` または `読み返し中` の導線が出る。follow ON なら assistantText streaming が自然に追従し、session 切替で follow state と新着導線がリセットされる |
| MT-036A | Latest command pane stability | 実行中に複数の step 更新を発生させながら right pane を観察する | right pane は scroll / follow UI を持たず、最新 command 1 件だけに置き換わる。message list の follow 挙動には干渉しない |
| MT-037 | Pending indicator accessibility | screen reader 相当の確認環境または accessibility tree を使い、streaming 中に pending bubble を観察する | pending bubble 全体が token ごとに過剰再通知されず、実行中 indicator の状態変化だけが最小限に扱われる。screen reader 向け文言も visible text と同じ方針で、character 名ベースまたは一般化 fallback に同期している |
| MT-038 | Retry banner state split | `interrupted` / `error` / user cancel の各状態を作り、composer 上の retry banner を見比べる | interrupted / failed / canceled の識別が badge / title / CTA で維持され、状態別 body 段落なしでも copy が混線しない。collapsed 時でも CTA と draft conflict notice は操作可能で、`running` 中と通常 `idle` では banner が出ない |
| MT-039 | Retry banner canceled truth source | Cancel 完了後に session が `idle` へ戻った状態で composer を確認する | `runState === "idle"` でも最新 terminal Audit Log `phase === "canceled"` を真実源として canceled banner が表示され、通常 idle とは誤判定しない |
| MT-040 | Retry CTA behavior split | retry banner 表示中に `同じ依頼を再送` と `編集して再送` をそれぞれ試す | `同じ依頼を再送` は即時送信されて draft を変えず、`編集して再送` は `lastUserMessage.text` を draft に戻して textarea へ focus するが自動送信しない |
| MT-041 | Retry edit draft protection | retry banner 表示中に別の文面を draft へ入れたまま `編集して再送` を押す | 入力中 draft は silent overwrite されず、composer 内で `今の下書きは残しています。` の短い notice と「置き換える」導線が出る。置き換えを確定した時だけ前回の依頼へ差し替わる |
| MT-042 | Retry banner details toggle default | canceled / failed / interrupted の各 retry banner を初回表示し、`Details` / `Hide` を切り替える | `canceled` は初期 collapsed、failed / `interrupted` は初期 expanded で表示される。toggle で `停止地点` / `前回の依頼` が開閉し、badge / title / CTA は常時残る |
| MT-043 | Retry banner details reset / preserve | retry banner を開閉したまま draft を編集し、その後 session 切替と別 interruption 発生をそれぞれ試す | 同一 retry banner 上の draft 編集や軽微な再描画では open / closed state が維持される。session 切替または retry banner identity（kind / `lastUserMessage` / canceled 判定に使う terminal Audit Log entry）変化時は default 状態へ reset する |
| MT-044 | Retry banner non-regression | retry banner が出る session で message list follow banner、pending indicator persistence、composer layout を確認する | retry banner 追加で不要なスクロールジャンプや composer 崩れが起きず、`新着あり` / `読み返し中` banner と pending indicator の既存挙動も維持される |
| MT-045 | Retry banner no last user message | user message がまだ 0 件の session、または user message を持たない復旧ケースを開く | interrupted / failed / idle+canceled 判定相当でも `lastUserMessage` がなければ retry banner は出ない |
| MT-046 | Session boundary no-bleed after switch | session A で canceled banner または pending / live run を表示したまま、Home か session 一覧から session B へ切り替え、切替直後の composer / message list / Audit Log を確認する | session B では retry banner 判定、`停止地点` summary、pending / live run 表示、Audit Log が session A の値を一瞬も引きずらず、session B 自身の state だけを表示する |
| MT-047 | Composer sendability feedback 統合 | provider 無効化、壊れた `@path`、blank / whitespace draft をそれぞれ作り、composer を確認する | `sessionExecutionBlockedReason` / 添付 error が Send 近傍の単一 feedback area に集約される。blank / whitespace draft は helper 文言を出さず、`Send` disabled だけになる |
| MT-048 | Composer send guard 一致 | blank / whitespace draft のまま Send、`Ctrl+Enter`、`Cmd+Enter` をそれぞれ試し、続けて有効な draft で再試行する | blank / whitespace draft は button と shortcut の両方で送信されず、textarea 内で no-op turn も作られない。有効な draft では button と shortcut の両方で同じ条件で送信できる |
| MT-049 | Running composer priority | `runState === "running"` の間に composer を確認する | composer では `Cancel` が主表示のまま残り、sendability feedback が主表示に割り込まない。retry banner も出ない |
| MT-050 | Attachment chip readability | workspace 内 file / folder / image と workspace 外 path をそれぞれ `@path` で添付し、長い path も含めて composer を確認する | attachment chip が kind、basename、`ワークスペース内` / `ワークスペース外` を見分けやすく表示し、長い path でも basename が先に読める |
| MT-051 | `@path` keyboard navigation | query 非空で `@path` 候補を開き、`ArrowUp` / `ArrowDown` / `Enter` / `Tab` / `Escape` と mouse を試す | 候補 open 中だけ keyboard navigation が働き、basename 優先 row で active 候補が視認できる。`Enter` / `Tab` で候補採用、`Escape` で close、候補を閉じた通常時の textarea 操作と `Ctrl+Enter` / `Cmd+Enter` 送信は退行しない |
| MT-052 | Home session badge precedence / sort | Home に `status === "running"`、`runState === "running"`、`runState === "interrupted"`、`runState === "error"`、non-active session が混在する状態を作る | `running` が最優先、次に `interrupted`、次に `error`、それ以外は neutral badge で card に残る。card 並びは active state 優先へ再ソートされず、storage 既定の `last_active_at DESC` を保つ |
| MT-053 | Home monitor open session truth source / search sync | 複数 session を用意し、そのうち一部だけ `SessionWindow` を開く。Home 右ペインを `Session Monitor` にして、続けて session search で一部 session だけに絞り込む | monitor panel は open な `SessionWindow` を持つ session だけを出し、`実行中` と `停止・完了` に分かれる。`interrupted` / `error` / neutral は `停止・完了` 側へ badge 付きで残る。検索結果から外れた session は `Recent Sessions` card と monitor row の両方から消える |
| MT-054 | Home monitor open / close follow | Home を開いたまま session card から `SessionWindow` を開き、続けて対象 window を閉じる。可能なら複数 session で繰り返す | `SessionWindow` を開いた session は monitor に追加され、閉じた session は monitor から消える。Home 再読み込みなしで右ペイン表示が追従する |
| MT-055 | Home right pane segmented toggle / initial state | Home を起動し、右ペイン上部の切替 UI を確認した後、`Session Monitor` / `Characters` を相互に切り替える | 起動時は `Session Monitor` が選択済みで、right pane には片方だけが表示される。segmented toggle だけで現在選択中が見分けられ、`Characters` 選択時だけ character search / list / `Add Character` が表示される |
| MT-056 | Home session empty / no-result と monitor empty state | session 0 件の状態で Home を開き、その後 session を作成して `SessionWindow` を開かないケース、さらに search で 0 件になる条件も試す | session 0 件では `Recent Sessions` に空状態メッセージと `New Session` 導線が見える。open な `SessionWindow` が 0 件なら monitor 側は説明文ではなく短い empty state を出す。search 0 件では `一致するセッションはないよ。` が出て、monitor 側も同じ検索条件に追従した no-result 表示になる |
| MT-057 | Home right pane heading dedupe | Home を開いて `Session Monitor` / `Characters` を切り替え、right pane の先頭付近を確認する | active pane は segmented toggle だけで判別でき、pane 内トップに `Session Monitor` / `Characters` の重複 heading は出ない。`Characters` 側では search row 近辺に `Add Character` 導線が残る |
| MT-058 | Home monitor scroll / CSS no-bleed | monitor 対象になる open session を増やして right pane を縦にあふれさせた後、Home でスクロール挙動を確認する。続けて Session Window を開いて pending / retry banner / composer 周辺の既存表示も見る | `SessionMonitor` は right pane 内で自然に縦スクロールし、wrapper 全体が伸び続けない。Home 専用の 2 カラム / right pane toggle / monitor 用 CSS が Session Window へ波及せず、Session 側の既存レイアウトと配色が退行しない |
| MT-059 | New Session approval default | Home から `New Session` dialog を開き、新規 session を作成する | session 作成直後の approval 初期値が `safety` で保存され、UI 表示は `安全寄り` になる |
| MT-060 | provider-neutral approval UI | Session Window の composer approval chip、artifact `Run Checks`、`Audit Log` overlay を見比べる | approval がすべて `自動実行 / 安全寄り / プロバイダー判断` の provider-neutral wording で揃う |
| MT-061 | legacy approval normalize | legacy DB または既存 row に `never / untrusted / on-request / on-failure` を含む session / audit log を読み込む | session approval chip、Audit Log、artifact `Run Checks` がそれぞれ `allow-all / safety / provider-controlled` 相当へ normalize され、表示は provider-neutral wording になる |
| MT-062 | Skill Root settings | Home の `Settings` で provider ごとの `Skill Root` を入力または `Browse` で選び、`Save Settings` して再度開く | skill root path が保存され、provider ごとに保持される |
| MT-063 | Skill picker と挿入 | Session Window の composer 上部にある `Skill` を開き、候補を選ぶ | skill 候補が dropdown で表示され、選択すると Codex では `$skill-name`、Copilot では skill directive が composer 先頭へ挿入される |
| MT-064 | Skill picker empty state | skill が 0 件の session で `Skill` を開く | 空状態メッセージが出て、textarea の通常入力や送信導線は固まらない |

## 補足

- `DB を初期化` は DB file 削除ではなく Main Process の論理 reset を使う
- `Character Stream` は現行 UI に含まれないため、項目表にも含めない
