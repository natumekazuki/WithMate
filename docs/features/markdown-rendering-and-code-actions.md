# Markdown表示とcode block操作

## 概要

WithMateのMarkdown Previewは、chat messageとFile Previewで共通のrich text rendererを使用します。v6.3.25では、YAML front matter、list、fenced code blockの表示と操作を整理しました。

## YAML front matter

Markdown先頭のYAML front matterは本文から分離します。Previewではkeyとvalueの表として表示し、その後にMarkdown本文を表示します。

front matterとして認識するのはdocument先頭のdelimiterで囲まれた範囲です。本文中のhorizontal ruleやcode blockをfront matterとして扱いません。

Source表示では元のMarkdownを変更せず、そのまま表示します。

## listの余白

ordered listとunordered listでは、markerと先頭行のbaselineを揃えます。隣接するlist itemへ通常paragraphと同じ余白を重ねず、item内に複数段落がある場合だけ必要な段落間隔を残します。

rendererが生成するDOM構造に応じて余白を決め、Markdown sourceへ空行を追加しません。

## fenced code blockのCopy

fenced code blockの操作は、block上部のsticky action rowへ表示します。長いcodeをscrollしても、表示領域上部から`Copy`へ到達できます。

action rowには不透明なsurfaceを使用し、背後のcodeとlabelが重ならないようにします。

Mermaidはdiagram表示側の操作と重複するため、共通のcode block `Copy`対象から除外します。

## keyboard操作

File PreviewのPreviewとSourceの切り替えはshortcut registryへ登録されています。現在のsurfaceがMarkdownでない場合は実行しません。

## 関連文書

- [Message Rich Text](../design/message-rich-text.md)
- [キーボードショートカット](keyboard-shortcuts.md)
