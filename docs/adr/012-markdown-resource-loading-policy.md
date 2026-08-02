# 012 Markdown Resource Loading Policy

- 状態: Accepted
- 日付: 2026-08-02

## Context

現行の shared Markdown renderer は画像を描画せず、Content Security Policy も HTTP / HTTPS image を許可していない。Session の file preview では Markdown 内の local image と external image を通常の Web content と同じように確認したい。また、chat と file preview で Markdown の構文、link、image の挙動を分岐させたくない。

external image の自動取得は remote host へ接続し、IP address、User-Agent、参照時刻などの接続情報を伝える可能性がある。SVG を inline DOM として挿入すると、画像表示に不要な active content 境界を増やす。

## Decision

- chat と file preview は同じ Markdown renderer と resource resolution contract を使う
- local、HTTP、HTTPS、data、blob image を確認ダイアログなしで既定表示する
- Content Security Policy の `img-src` で HTTP / HTTPS image を許可する
- Markdown file の相対 resource は file の親 directory と同じ認可済み root の中で解決する。chat 内の local image は absolute path または `file:` URL を扱い、root をまたぐ相対 path 探索は行わない
- file preview の local resource 読込は Main process の許可済み root 判定を経由し、renderer へ任意 filesystem API を公開しない。link click は明示的な OS open 操作として typed result を返す
- file preview の local image は preview 単位の固定同時数キューで解決する。file、reload、表示 mode、encoding の切替または unmount では待機中の処理を破棄し、実行中の chunk read も stale generation を検出して止める。表示を継続する切替では、同じ image source も current generation へ再登録する
- user-provided SVG は image resource として描画し、inline DOM または `dangerouslySetInnerHTML` へ渡さない
- image load failure は非表示にせず、対象 resource と再試行可能性が分かる状態を表示する
- external image の自動通信は明示的な product choice とし、初期実装では per-image confirmation または host allowlist を追加しない

## Alternatives

- すべての画像を非表示にする: Markdown preview と chat の確認用途を満たさないため採用しない
- external image だけ確認ダイアログを出す: 通常の Web content と同じ閲覧体験にする今回の方針と合わず、反復操作も増えるため採用しない
- external image を Main process で proxy する: request ownership、cache、cookie、timeout、content validation の別契約が必要になり、初期 scope を超えるため採用しない
- SVG を inline render する: active content と sanitization の境界を増やすため採用しない

## Consequences

### Positive

- chat と file preview で同じ Markdown が同じように表示される
- local documentation と外部 documentation の画像を追加操作なしで確認できる
- SVG を passive image boundary に限定できる
- Markdown 内の image 数が増えても local inspect / read の同時実行数が固定される

### Negative

- external image の host へ接続情報が伝わり得る
- network failure、認証が必要な image、CSP または OS resource access failure を UI で区別して扱う必要がある
