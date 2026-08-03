# 015 File Root Scoped Git Changes

- 状態: Accepted
- 日付: 2026-08-03

## Context

Session File Explorer の Files は、Workspace、Session Folder、Additional Directory を独立した root として表示する。一方、Changes と live Git Diff は Workspace だけを対象としていた。この差により、Additional Directory が Git repository またはその一部であっても、利用者は File Explorer から変更を確認できなかった。

Changes の対象を広げるとき、renderer から絶対 path を受け取ると、File Explorer の許可済み root を迂回して任意の directory を Git 操作へ渡せる。複数の root が包含関係にある場合は、同じ file が複数の root の scope に属することもある。

Git process、repository identity、config、index、resource limit の隔離方法は ADR 014 が定めている。この判断では、どの directory を ADR 014 の操作へ渡せるかと、複数 root の結果をどう表示するかを決める。

## Decision

- Changes と live Git Diff の request は `sessionId` と `rootId` を組として持つ。renderer から絶対 path を受け取らない
- Main process は操作ごとに、Files と同じ root resolver で現在の許可済み root を解決する。存在しない、削除済み、または別 Session の `rootId` は拒否する
- Git status と diff は、解決した root を一つの scope として ADR 014 の隔離境界で実行する。repository 全体へ scope を自動拡張しない
- Changes は Files の root 順に取得する。非 Git root と未作成 root は表示せず、Git root ごとに Working Tree と Staged を表示する
- 一つの root の取得失敗は、その root の理由として表示し、他の root の結果を破棄しない
- root は独立した表示 scope とする。親子関係にある root が同じ file を含む場合も重複を除去せず、それぞれの root からの相対 path で表示する
- status、diff、未追跡 file の preview、通常 file preview からの Open Diff、diff の Reload は、同じ `rootId` を維持する
- 複数 root の取得は逐次実行し、root 数に比例した Git operation を同時に queue へ投入しない。待機要求の置換単位は Session、root、operation kind の組とする

## Alternatives

- renderer から絶対 path を渡す: File Explorer の root 認可を迂回できるため採用しない
- 同じ repository に属する root を一つへ統合する: Files の root と Changes の表示 scope が一致せず、root 外の変更を混ぜないための追加規則が必要になるため採用しない
- 包含関係では最も内側の root だけに file を表示する: 親 root の一部だけが暗黙に除外され、root の追加や削除によって変更の表示位置が移動するため採用しない
- 非 Git root も理由付きで表示する: Changes の情報量が増える一方で操作可能な項目がないため採用しない

## Consequences

### Positive

- Files に表示される許可済み Git root を、同じ認可境界のまま Changes から確認できる
- root ごとの scope と相対 path が Files と一致する
- Additional Directory の追加、削除、包含関係によって認可境界や表示規則が変化しない
- 多数の root を持つ Session でも、単一の表示更新が process 全体の Git operation 上限を一度に消費しない

### Negative

- 包含関係にある root では、同じ実 file が異なる相対 path で複数回表示される
- root ごとに status を取得するため、Git root 数に比例して表示完了までの時間が増える
- 非 Git root は Changes に現れないため、Files の root 数と Changes の root 数は一致しない
