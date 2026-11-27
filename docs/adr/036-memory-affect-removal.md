# ADR 036: MemoryとCharacter Affectの機構を撤去する

Session Graphの維持に関する範囲は[ADR 037](037-session-graph-removal.md)により適用対象外とする。

## Status

Accepted（2026-11-15）。本判断はMemory／Affectの専用機構と専用データの廃止に適用する。通常Session、Character定義、保存履歴、Session Graph、Repository Glossaryの責務は維持する。

## Context

Memoryの利用実態調査では、過去の記録を検索して本文を取得し、その内容と対応する回答・維持判断を返した例が観測された。数か月前の設計情報へ到達した例もあり、「保存しただけで一度も読まれていない」「無価値だった」とする根拠にはならない。

一方、主標本は一つの長い開発Sessionが中心であり、取得した判断は保存会話、Graph、repositoryの正本と重複していた。Memory固有の回答改善、再説明削減、誤判断防止の因果効果や、跨Sessionの共有経験の価値は分離できていない。Affectの毎Turn投影はMemory検索とは別経路であり、Memoryの利用件数からAffectの価値を判定しない。

専用の保存・暗号化添付・認可・MCP／CLI・UI・設定・prompt投影・背景実行・診断・検証を維持する負担に対し、独立した体験価値を未分離のまま現方式を継続するかが判断対象となった。ユーザーは機構撤去を選び、専用データについて「退避せずに破棄でいいや」、製品外について「製品外はそのままで」を採用した。これは実益を定量実証した結論でも、調査による価値ゼロの証明でもない。

## Decision

製品内の一般Memory、Character Memory／episode、Character Affectを、専用の付随物と一体で撤去する。公開MCP／CLI、Character contextとAffect投影・afterglow、背景三用途と専用History公開入口、登録指示・頻度・設定、Memory Review・専用診断、暗号化添付・keyring、専用schema・test・文書・配布入口を対象とする。互換Memory stub、空成功での救済、代替の記憶／感情機構は設けない。

通常Main／Auxiliary、会話・操作履歴と通常Session APIの履歴read engine、Character定義catalog／editor／snapshot、Timing、Session Graph、Repository Glossary、project_scopes、共有DB、通常の認可・binding・storage generation失効・取消、Prompt TemplateとPickerを維持する。Memory配下にあった共有runtimeは専用機構と切り離し、既存のinstance／generation照合・操作認可を残す。撤去を全DB resetや共有資産の削除へ拡張しない。

### 保存データと適用境界

更新後の起動storage更新経路で、Memory／Affect専用table・保存本文・event・episode・version／idempotency等の付随行、専用設定、管理対象の暗号化添付とkeyringを退避せず破棄する。fresh DBにも専用機構を作らない。破棄した専用データを旧sourceから再取込・再生成しない。

通常Session・履歴・Character資産・Graph・Glossary・project_scopes・共有file／blobは保持する。元の取込file、利用者がexportしたfile、V4 source、共有fileは専用データ破棄の対象外である。コードのGit復元元は保存データのbackupではなく、コードを戻しても破棄済みの記録・添付は復元できない。

稼働中の実DBへの直接削除、稼働アプリの起動・交換は今回の実装操作に含めない。storage更新はsynthetic fixtureで検証し、local実装・検証の完了を、稼働環境への適用・データ破棄完了と区別する。

### 製品外

ユーザーhomeのAGENTS／guide／Skill、Character pack、外部Provider設定、既設POSIX shim・Windows aliasは変更・清掃しない。起動cleanupやinstaller／uninstallerへ既設外部登録の清掃を追加しない。外部ルールに旧tool参照が残るのはこの選択によるものであり、互換入口を維持する理由にはしない。push、release、GitHubへの外部writeは本判断による承認対象ではない。

## Alternatives

- 現方式を維持する案は、跨Sessionの想起と感情の継続を残せるが、専用の保存・実行・運用・検証負担も残る。
- 正本との重複だけを縮小する案は、将来価値を保ち得るが、専用機構の責務と境界を引き続き維持する必要がある。
- 退避後に撤去する案は、専用データを後で参照できる一方、export・保護・復旧の保守責務が残る。ユーザーは退避を新設せず破棄する案を選んだ。
- 互換stubや別の記憶／感情storeへの置換は、廃止した責務を別名で残すため採用しない。

## Consequences

期待していた跨Sessionの経験・判断の能動想起、Characterごとのepisode継続、関係感情と一時感情の保存・時間減衰・別Sessionへのafterglowは失われる。Characterの声・選び方は定義と現在の会話文脈に依存する。通常Session履歴の明示読取、Graphによる作業条件・判断の共有、Glossaryによるrepository用語の参照は残るが、Memory／Affectと同じ体験の代替を保証しない。

専用の保存・公開入口・背景処理・投影・診断・設定を維持する負担は除去する。この削減量を回答品質や体験価値の改善量とはみなさない。

## 復元元と削除地点

削除前のコード・文書の復元元Pは [e60cee1cc31a805be29bfa42c98bddce6a6f113e](https://github.com/natumekazuki/WithMate/tree/e60cee1cc31a805be29bfa42c98bddce6a6f113e) である。Pには両機構が存在することを確認した。

- [Memory runtime source](https://github.com/natumekazuki/WithMate/blob/e60cee1cc31a805be29bfa42c98bddce6a6f113e/src-electron/memory/memory-v6-runtime.ts)
- [Affect service source](https://github.com/natumekazuki/WithMate/blob/e60cee1cc31a805be29bfa42c98bddce6a6f113e/src-electron/character/character-affect-service.ts)
- [Memory設計](https://github.com/natumekazuki/WithMate/blob/e60cee1cc31a805be29bfa42c98bddce6a6f113e/docs/design/v6-memory-foundation.md)
- [跨SessionのAffect設計](https://github.com/natumekazuki/WithMate/blob/e60cee1cc31a805be29bfa42c98bddce6a6f113e/docs/features/cross-session-affect-afterglow.md)

削除commit Dは [da64723f6073955becf1859c265ccfcba70da16b](https://github.com/natumekazuki/WithMate/commit/da64723f6073955becf1859c265ccfcba70da16b)（`refactor: Memory・Affectの専用機構を撤去`）であり、直接の親はPである。撤去差分は [P..D（e60cee1cc31a805be29bfa42c98bddce6a6f113e..da64723f6073955becf1859c265ccfcba70da16b）](https://github.com/natumekazuki/WithMate/compare/e60cee1cc31a805be29bfa42c98bddce6a6f113e..da64723f6073955becf1859c265ccfcba70da16b) で参照する。この削除地点の記録はD後の別のdocs commitで追加し、PとDを区別する。Dのlocal commit確定は、稼働環境への適用・データ破棄完了やreleaseを意味しない。

## 従前判断の適用範囲

ADR 017／018／020／024／028のMemory／Affect専用判断を置き換える。ADR 021／023／027／029／035は専用機構・背景実行・専用History公開入口の範囲を適用対象外とし、残存する通常Session／Graph／Glossaryの共有認可・instance／generation・MCP／CLI契約や履歴readの責務は維持する。各ADRの当時の本文は保持する。
