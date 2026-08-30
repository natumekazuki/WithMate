# Prompt Template workspace

## 概要

Prompt Template workspaceは、保存済みTemplateを確認、編集し、composerへ挿入する中央surfaceです。Templateを選択した時点でpromptを挿入し、追加の確定操作を要求しません。

## Templateの挿入

workspaceを開く時に、composerの選択範囲とcaret位置を記録します。Templateを選択すると、その範囲をTemplate本文で置き換えます。選択範囲がない場合はcaret位置へ挿入します。

挿入後はcomposerへfocusを戻し、利用者が続けて編集できる状態にします。

## Templateの編集

Templateの作成、更新、削除は既存の保存領域へ反映します。更新後に一覧を再取得しても、可能な限り選択中のTemplateとkeyboard focusを維持します。

未保存の編集がある状態でworkspaceを閉じる場合は、既存のclose guardに従います。

## 中央surfaceの排他制御

Prompt Template、Skill picker、File Preview、Git Diff、commit history previewは同じ中央surfaceを共有します。同時に複数を重ねず、新しいsurfaceを開く前に現在のsurfaceを閉じられるか確認します。

close guardが閉じる操作を拒否した場合は、新しいsurfaceを開きません。

## UI表記

TemplateとSkillのclose操作は同じbutton primitiveを使用します。操作labelは現在のUI表記に合わせて英語へ統一し、操作を説明するだけの常設文は表示しません。

## 関連文書

- [Session interfaceの変更](session-interface-refinements.md)
- [Desktop UI](../design/desktop-ui.md)
