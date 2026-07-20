# ADR 007: Session表示名とローカルRepository識別情報

- Status: Accepted
- Date: 2026-07-18

## Context

Session一覧と検索では、opaqueなSession IDとは別に人が識別できる表示名が必要である。また、同じローカルGit Repositoryから作成したSessionをまとめるには、directory basenameだけの`repositoryName`では衝突し、Workspace absolute pathではlinked worktreeを同じRepositoryとして扱えない。

remote URLはclone間の相関には使えるが、remoteを持たないRepository、複数remote、URL変更、forkを一意に扱えない。Git管理外のWorkspaceもSession作成対象であり、Git検出の失敗によってSession作成自体を停止させるべきではない。一方、ローカルabsolute pathをpublic APIへそのまま追加すると、表示に不要なhost情報を露出し、path移動の追跡責務も増える。

Session作成はcaller-ownedなidempotency keyでexact retryできる。Git状態は最初の試行とretryの間に変わり得るため、caller入力と環境から導出したsnapshotを同じfingerprint規則にしてはならない。

## Decision

Sessionは次のmetadataを保持する。fieldのvalidation上限とpublic projectionはtype、schema、Application / CLI contract testを正本とする。

- `title`: callerがSession作成時に必ず指定する表示名。trim後のcanonical valueを保存し、一意性は要求しない。Session identityは引き続き`sessionId`とする。
- `localRepositoryKey`: ローカルRepository familyを識別するversion付きopaque key。Git common directoryのrealpathをhost path identity規則で正規化し、SHA-256化した`local-repository-v1-sha256-<hex>`を保存する。
- `repositoryName`: Git common directoryから導出する表示・検索用名称。通常Repositoryでは`.git`の親directory名、bare Repository等ではcommon directory basenameから末尾`.git`を除いた値とする。一意性は要求しない。

`localRepositoryKey`は同じcloneのmain worktreeとlinked worktreeで一致し、別cloneでは一致しない。machineをまたぐRepository identityやremote origin identityとしては使用しない。hash元のabsolute pathはSession rowやpublic responseへ保存しない。

Git管理外のWorkspace、Git executableの不在、permission failure、timeout、malformed outputでは、`localRepositoryKey`と`repositoryName`をともにnullとする。両fieldは常に同時に値を持つか、同時にnullとする。Git検出はWorkspace validationとauthorizationの後、persistence開始前にbest effortで行う。timeoutまたはcaller cancellationによるApplication operation自体の中断はbest effort failureへ変換せず、persistence未開始のoperation failureとして返す。

Repository由来の2 fieldはSession作成時のsnapshotとし、後続の`git init`、Repository移動、名称変更を自動追跡しない。`title`はRepository検出と独立したuser-owned metadataとし、idempotentな専用operationで更新できる。title更新はSession activityとはみなさず、`lastActivityAt`を変更しない。child Sessionは独自の`title`を持ち、`localRepositoryKey`と`repositoryName`はparent Sessionに保存済みの組を継承する。

create idempotency fingerprintにはcaller intentである`title`を含める。Git由来の2 fieldはfingerprintから除外し、exact retryでは最初に永続化した組を返す。retry時の再検出結果と保存済みresponseが異なってもconflictにしない。

現行schema v1は提供前のclean-start契約であり、既存database migrationは追加しない。CLIへのadditiveなfield追加でも現行`withmate-cli-v1`を維持する。

## Alternatives

- `repositoryName`だけをRepository identityにする: 同名directoryが容易に衝突するため採用しない。
- Workspace pathをそのままRepository keyにする: linked worktreeが別物になり、raw local pathもpublic metadataへ露出するため採用しない。
- canonical remote URLをRepository keyにする: remoteなし、複数remote、URL変更、fork、認証形式差を安定して扱えないため採用しない。
- initial commit hashをRepository keyにする: unrelated historyやhistory rewriteを安定して区別できず、浅いclone等の追加条件も生むため採用しない。
- RepositoryにWithMate固有IDを書き込む: repositoryへの外部副作用と同期規則が必要になるため採用しない。
- Git検出不能時にSession作成を拒否する: Git管理外Workspaceを除外し、Git availabilityをSession persistenceの必須条件にするため採用しない。
- Repository移動を自動追跡する: stableな外部identityなしに旧pathとの同一性を推測することになるため採用しない。

## Consequences

- UIとCLIは`title`を主表示に使い、`repositoryName`を補助表示、`localRepositoryKey`をローカルgroup/filter候補として使える。
- `repositoryName`と`localRepositoryKey`のどちらもグローバルな一意性を保証しない。Sessionの直接addressingには`sessionId`を使う。
- 別cloneを同じremote Repositoryとして横断集約する用途には、将来別のremote-derived metadataと明示的な不確実性規則が必要になる。
- Git検出failureはSession作成を妨げない代わりに、Git Repositoryでもmetadataがnullになる場合がある。再検出APIを追加するまではcreate snapshotを維持する。
- raw local pathを保存しないため、hashから元pathを復元する機能やRepository移動追跡は提供しない。
