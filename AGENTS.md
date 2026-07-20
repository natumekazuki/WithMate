# WithMate Coding Agent Working Agreements

このファイルは、WithMateの新実装を扱うcoding agent向けのリポジトリ規約である。より深いdirectoryに対象を限定した`AGENTS.md`がある場合は、そのdirectory内だけ追加規約を適用する。

## 作業の起点

- WithMateは完全な0ベース再構築として進める。全体方針と文書の入口は`docs/index.md`を正本とする。
- root直下のsource、test、schema、docsが新実装である。`old/`は旧実装の退避領域であり、現行設計の正本ではない。
- 作業開始時にcurrent branch、`git status --short`、適用されるinstruction、現在のroadmap checkpoint、回答待ちのquestionを確認する。
- 要求、制約、期待する観測結果、完了条件を短く整理し、関連するsourceとexecutable contractを読んでから判断する。
- ユーザーが明示していないcommit、push、PR作成、外部write、破壊的操作は行わない。

## 0ベース再構築

- 旧実装のAPI、schema、責務境界、directory構成、依存関係をそのまま移植しない。
- `old/`は、過去の挙動や失敗例を調査する必要がある場合だけ参考にする。旧roadmap、旧設計文書、旧testを現行contractの根拠にしない。
- 既存機能を無条件に復元しない。採否は`docs/feature-inventory.md`、現行roadmap、accepted design、ユーザー要求から判断する。
- 旧実装との互換layer、fallback、import、data migrationは、accepted contractとして明示されない限り追加しない。
- 新実装から旧DB fileを参照、変更、自動削除しない。pathやtable名を推測して旧DBを開かない。
- 現在の構造を守るためだけの局所修正より、accepted contractに整合する単純な最終状態を優先する。

## 正式リリース前の手戻り

リリース段階とDB schema運用の正本は`docs/design/sqlite-schema-lifecycle.md`である。現在は同文書の「正式release前のversion 1」を適用する。

- 最初の正式releaseまでは、外部consumerとの互換契約が成立していないpre-release API、保存形式、内部構造を置き換えてよい。古い経路をfallbackとして残さず、依頼範囲のcaller、test、schema artifact、文書を同じ論理変更で現行契約へ揃える。
- schema version 1のDDLとmanifestは、同じ論理変更内で更新できる。開発buildが作成したDBは互換保証の対象外であり、schema差分のためだけにmigration、compatibility reader、変換scriptを追加しない。
- 互換性のない開発DBが残る場合は、明示的な再作成が必要であることを報告する。applicationやagentが既存DBを自動削除してはならない。
- 手戻りを許容するのは、不要な後方互換性を抱えず設計を整えるためである。ユーザーの未コミット変更、Git履歴、旧DB、個人データを無断で破棄する許可ではない。
- pre-releaseであっても、security、privacy、data integrity、transaction、concurrency、resource limit、error semanticsを弱めない。
- accepted design、公開済みtype、信頼できるexecutable contractを変更する場合は、変更理由と利用者への影響を特定し、sourceとcontractを同じ論理変更で更新する。
- `docs/design/sqlite-schema-lifecycle.md`が最初の正式releaseによるversion 1の凍結を示した後は、このpre-release例外を適用しない。version 2以降の前進migrationと回帰contractを追加し、このファイルも同じ変更で更新する。

## Source of truth

関心事ごとに正本を分ける。

- 現在の実装と構造: root直下のsource code
- 観測可能な期待動作、不変条件、failure mode: test、type、schema、static check
- 現行schema: `schema/sqlite/v1.sql`と`schema/sqlite/manifest-v1.json`
- 非局所的な設計制約: `docs/design/`
- 長期的または後戻り困難な判断理由: `docs/adr/`
- checkpoint、依存関係、scope: `docs/plans/20260712-withmate-rebuild-roadmap/plan.md`
- roadmap上の判断: `docs/plans/20260712-withmate-rebuild-roadmap/decisions.md`
- 回答待ち: `docs/plans/20260712-withmate-rebuild-roadmap/questions.md`
- 検証済み進捗とaccepted risk: `docs/plans/20260712-withmate-rebuild-roadmap/worklog.md`
- 外部runtimeの実測: `docs/investigations/`

sourceとexecutable contractが矛盾する場合は、testを現在の実装へ合わせて弱める前に、ユーザー要求、accepted ADR、design、外部consumer、履歴上の根拠から意図を確定する。結果を実質的に変える判断を確定できない場合だけ、選択肢と影響を示して確認を求める。

## Roadmapとscope

- 現在のcheckpointと依存関係はroadmapを確認する。下位層のGateを飛ばしてGUIやProvider固有実装を先行させない。
- checkpoint開始時は`questions.md`を確認し、回答待ちが作業結果を変える場合は実装を止める。
- 依頼されたsliceの外にある将来機能を便乗実装しない。必要性を見つけた場合は、根拠と依存関係を報告する。
- checkpoint完了はfile作成やtest件数ではなく、planに定義された観測可能なGateの通過で判断する。
- scope変更は`decisions.md`へ理由を置き、plan、questions、worklogのうち直接影響する正本だけを更新する。

## Architecture boundaries

- 中核use caseはUIやProvider transportに依存しないApplication Serviceとして実装する。
- CLIを先行clientとし、後続GUIも同じApplication contractを利用する。CLIやGUIからSQLiteまたはPersistence Worker内部へ直接到達しない。
- SQLite connection、schema適用、repository read/write ownershipはPersistence Workerへ閉じる。
- Provider固有protocol、ID、resume、error mappingはProvider Adapter境界へ閉じ、domain modelやpublic projectionへ漏らさない。
- 永続化の正本、Application projection、CLI JSON、将来のGUI stateを混同しない。
- 大きい本文やBLOBはbounded pageまたはchunkとして扱う。通常の一覧やsummaryで全件hydrate、N+1 read、payload複製を行わない。
- authorization、workspace、Session、Run、Messageなどのowner tupleは、信頼境界ごとに再検証する。内部ID、raw payload、private path、secretをpublic responseやdiagnosticへ流さない。

## Change workflow

依頼種別に応じて作業範囲を守る。

- answer、explain、review、diagnose、plan: 必要なread-only調査と報告まで行い、変更依頼がなければ編集しない。
- change、build、fix: 依頼範囲の編集と非破壊的な検証まで進める。
- external action: 対象、影響、可逆性、権限を確認し、明示的に許可された操作だけを行う。

実装では次を守る。

- bug fixは対象failure modeを可能な範囲で修正前に再現し、修正後に最も直接的な方法で解消を確認する。
- public API、永続化、migration、外部副作用、authorization、concurrency、resource limit、ownerまたはscopeを変更する場合は、同じ不変条件を持つ兄弟入口、failure timing、public projection、recoveryを確認する。
- 同じ問題が複数入口にある場合は、callerごとの回避より、不変条件を所有する最小の共有境界で修正する。
- 一度に多数の仮説修正を入れず、failureを切り分けられる小さな変更を選ぶ。
- 無関係なcleanup、rename、format、dependency更新、refactorを同じ差分へ混ぜない。
- 現在の表現や内部call順を固定するtestではなく、利用者から観測できる結果、不変条件、failure modeを検証する。
- failing test、type、schema、static checkを、現在のsourceに合わせるためだけに削除、skip、弱体化しない。

## Code and comments

- TypeScriptはstrict、ES modules、既存のproject reference構成に合わせる。
- directoryとmoduleは、技術種別だけでなくdomain、feature、capability、ownershipなど安定した変更理由で分ける。
- public型はinvalidな状態の組を表現しにくいdiscriminated unionやexact validationを優先する。
- plain object、arrayの密度、文字列長、byte長、整数範囲、unknown fieldを信頼境界で検証する。type assertionをruntime validationの代用にしない。
- コメントは処理内容ではなく、コードから復元できない理由、外部制約、競合対策、failure boundaryを書く。詳細は`docs/development/source-comment-guidelines.md`に従う。
- TODO、FIXME、HACKを残す場合は、Issueまたはrepo相対planへのpointerと解消条件を付ける。
- source、test、document、生成物へ個人環境の絶対path、token、secret、raw Provider responseを残さない。

## Knowledge placement

- validation ruleやfailure modeは、可能ならtest、type、schema、static checkへ置く。
- 一つのcode locationの近くで理解できる理由はcode commentへ置く。
- 複数の妥当な選択肢から一つを選ぶ場合、またはpublic contract、永続化、migration、security、concurrencyなど後戻りコストが高い新しい判断を行う場合はADRを作る。既存のaccepted ADRやdesignが同じ判断理由を所有している場合は、新しいADRを重複させない。
- ADRにはcontext、decision、alternatives、consequencesを残し、現行class構成やAPI一覧を複製しない。
- 恒久的なdesign文書には、複数subsystemへ波及し、sourceやtestだけから復元できない制約だけを残す。
- 現行file構成、通常のAPI入出力、局所的な処理順を、実装の写経としてdesign文書へ同期しない。
- 既存designが判断理由をすでに所有している場合は、新しいADRや重複文書を作らずpointerを使う。

## Worktree and Git safety

- 作業前後に`git status --short`を確認し、既存のstaged、unstaged、untracked changeをユーザーの作業として保護する。
- ユーザーの変更をreset、checkout、restore、stash、clean、上書きしない。変更が重なる場合は差分を読み、共存できないときだけ確認を求める。
- filesystemの削除、再帰移動、DB再作成など破壊的操作は、対象をread-onlyで特定し、依頼範囲と明示権限を確認してから行う。
- commitとpushは別々の外部作用として扱い、それぞれユーザーが明示した場合だけ行う。
- commitする場合は対象diffとstagingを確認し、1つの論理変更へ無関係な差分を混ぜない。commit messageはconventional commitsを使う。
- `old/AGENTS.md`は旧treeを明示的に扱う作業でだけ参照する。新実装の規約としてrootへ持ち込まない。

## Validation

runtime要件は`package.json`を正本とする。現在はNode.js `>=24.16 <25`、npm `>=10.9 <12`である。

変更に最も近いtargeted checkから始め、リスクに応じて次へ広げる。

```text
npm run check:runtime
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:cli-session
npm run smoke:cli-run
npm run smoke:compiled-persistence
```

- すべての変更で全commandを儀式的に実行せず、対象failureと主要回帰を検出する最小構成を先に選ぶ。
- 永続化、public contract、module boundary、CLI lifecycleを変更した場合は、targeted test後に関連するbroad checkとprocess smokeへ広げる。
- schema変更ではDDLとmanifestを同じ論理変更で更新し、SQLite schema validator、foreign key、constraint、manifest hashを確認する。
- 実行できないcheckは成功扱いせず、理由、代替確認、未検証リスクを報告する。
- checkpointのGateを通過した場合は、実行した検証、未実行事項、残リスクをroadmapの`worklog.md`へ記録する。

## Review and completion

- reviewはfinding-firstとし、bug、regression、security、仕様逸脱、sourceとcontractの不一致、責務境界の崩れを優先する。
- findingはseverityとは別に`blocking`、`risk-candidate`、`non-material`、`invalid`へ分類する。accepted contractへの違反、supported scopeでの現実的な到達条件、具体的な影響、sourceまたはexecutable contractの根拠がそろう場合だけblockingとする。
- risk-candidateを受容する場合は、発生条件、影響、検知、復旧、再判断条件を`worklog.md`またはrepositoryの既存管理先へ残す。security侵害、secretや個人データの露出、不可逆なdata lossは自動的に受容しない。
- public contract、永続化、外部副作用、authorization、concurrency、resource limitに関わる非自明な変更は、実装とtargeted check後に独立した反例reviewを行う。
- blocking findingを修正した場合は、同じinvariant familyのtargeted checkとre-reviewで閉じる。
- source、executable contract、knowledge placement、必要な文書、検証結果が一致し、未解決のblocking findingがない状態を完了とする。
- 最終報告では、変更内容、実行した検証、未実行の検証、accepted risk、残リスク、commitや外部作用の有無を区別する。

## Language and reporting

- ユーザーへの回答、repository-owned document、commit messageは日本語で書く。identifier、API名、protocol field、error codeはsource上の表記を維持する。
- pathはrepo root相対で示し、logや成果物に個人環境の絶対pathを残さない。
- 実行していない操作を実行済みと書かない。推測、確認済み事実、未確認事項を分ける。
- 結論から報告し、判断根拠、重要な注意点、次のactionを必要な範囲で続ける。
