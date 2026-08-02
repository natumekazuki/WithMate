# 014 Isolated Workspace Git Preview

- 状態: Accepted
- 日付: 2026-08-02

## Context

Session File Explorer の Changes と live Git Diff は、Workspace の Git status と 1 file の patch を Main process で取得する。通常の Git process を Workspace から起動すると、次の入力が process 起動や読込対象を変更できる。

- Workspace に置かれた同名の Git executable
- 親 process から継承した `GIT_*` environment variable
- repository config と `.gitattributes` に設定された external diff、textconv、clean / process filter
- 認可後に行われる Workspace、Git directory、common directory の junction、symlink、rename による差し替え

認可前後に path や filter 設定を再確認するだけでは、確認と Git process の file open の間に再び変更できる。status / diff と事前確認を別 process に分ける方式では、外部 command の非実行と repository identity を同じ操作へ結び付けられない。

## Decision

- Git executable は最初の Git command を起動する時点で、process-start PATH の絶対 directory entry から絶対 real path へ解決して固定する。service construction だけでは resolver を起動せず、解決失敗は operation の typed failure とする。Git process は固定した executable だけを `shell: false` で起動する
- 子 process の environment は大文字小文字を区別せず継承元の `GIT_*` をすべて除去する。status / diff の隔離 invocation では system / global config を無効化し、service が所有する値だけを追加する。typed result の判定に使う Git message は `C` localeへ固定する
- repository identity の discovery では、canonical Workspace から filesystem root までの ancestor を command-local な `safe.directory` として列挙する。identity 確定後に元 repository を読む command は canonical repository top level だけを許可する。system / global config の `safe.directory` は変更しない
- 通常の checkout と同じ built-in working tree semantics を保つため、identity と directory lease の確立後に effective config から `core.autocrlf`、`core.eol`、`core.filemode`、`core.symlinks`、`core.ignorecase`、`core.precomposeunicode` だけを read-only で取得する。値は固定された scalar domain へ正規化し、隔離 invocation へ command-local config として投影する。filter、hook、external diff、textconv、credential、alias、include など他の設定は投影しない
- 操作中は Workspace、repository top level、Git directory、common directory の identity を保持する。Windows では各 directory 内に delete-on-close の一時 lease file を開き、親 directory の rename / replacement を操作完了まで成立させない
- directory identity を保持できない platform では Changes / live Git Diff を typed failure とし、path 前後確認だけへ fallback しない
- repository の HEAD と Workspace scope の index entry を、操作ごとの一時 Git directory へ投影する。`assume-unchanged`、`skip-worktree`、intent-to-add を含む index semantics も投影し、object content は認可済み common object directoryを alternate として参照する。intent-to-add は現在の working tree に対象 file が存在しない場合も、一時 work tree で extended flag を再現する
- status / diff は一時 Git directory の config と index を使用し、Git process の current directory と pathspec を Workspace scope に固定する。元 repository の local config を同じ invocation から外すことで、事前確認後に filter 設定が追加されても external command を実行しない
- status と diff は populated submodule の working tree へ再帰せず、dirty 判定を無視する。superproject が記録する gitlink commit の変更は維持し、submodule local config の filter / external command を親 operation の認可境界へ持ち込まない
- active clean / process filter の事前検出は、利用不可理由を返す UX のために維持する。安全性は事前検出ではなく、隔離した Git invocation が external command 設定を読み込まないことによって成立させる
- Workspace lease file は status、filter inspection、Changes の結果から literal exclude pathspec で除外する
- Git operation は process 全体の固定 active 数と固定 pending 数へ収める。同じ Session の同種の待機要求は新しい要求で置き換え、待機中は lease、一時 directory、child process を取得しない
- operation deadline では実行中の Git process を終了し、process の close を確認してから一時 Git directory と lease handle を破棄する。cleanup は bounded retry し、失敗を typed failure として timeout より優先して返す。残った cleanup 対象は process lifetime の backlog に保持し、次の service instance からも再試行する。polling や永続 snapshot は作成しない

## Alternatives

- repository config と attributes を事前確認してから通常の `git status` / `git diff` を実行する: 確認後に config / attributes を変更でき、外部 command の非実行を保証できないため採用しない
- 認可前後に canonical path と inode を比較する: directory を A から B へ差し替えて A へ戻す競合を検出できないため採用しない
- Workspace 全体と object database を一時領域へ複製する: identity と config を完全に隔離できるが、大規模 repository の I/O と一時容量が status / 1 file diff に比例しないため採用しない
- Git library で index、object database、attributes、diff を再実装する: 外部 process は不要になるが、Git format と working tree conversion の互換性を維持する責務が大きいため採用しない
- directory identity を保持できない platform で path 前後確認へ fallback する: 同じ認可境界を満たさない結果を同じ機能として返すため採用しない

## Consequences

### Positive

- Workspace 内の executable、継承された Git tracing / redirect、repository filter command を live Git preview から実行しない
- canonical root の差し替え中に別 repository の status や patch を返さない
- staged と working tree の index semantics、および 1 file 単位の Git patch 表現を維持できる。nested Workspace では repository 全体を status 対象にしない
- ownership が異なる repository でも global `safe.directory` を変更せず Changes を取得でき、一般的な改行・file mode 設定を持つ checkout では通常の Git status と同じ変更判定を維持できる
- filter 事前確認と安全性を分離し、設定変更競合を前後チェックへ依存させない

### Negative

- 操作ごとに一時 Git directory と Workspace scope の index projection を作るため、対象 index entry 数に比例する I/O が増える。file / diff content の hard reject 上限は設けないが、同時 operation と待機数は固定上限にする
- Windows では短時間の hidden lease file 作成が Workspace watcher から観測される可能性がある。Changes と filter inspection からは除外する
- allowlist 外の repository local config と、許可 domain 外の値は隔離 invocation に投影しない。特殊な built-in conversion 設定を持つ repository では typed failure または通常の Git CLI と異なる patch になる可能性がある
- populated submodule 内だけに存在する未commit変更は Changes に表示しない。gitlink commit の staged / working tree change は表示する
- directory identity を保持する実装がない platform では Changes / live Git Diff を利用できない。対応する場合は path 前後確認ではなく、open directory handle に Git の全読込を結び付ける必要がある
