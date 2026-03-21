# Agent And Skill Command Design

## Goal

- WithMate の `/agent` と `/skill` をどこまで共通化できるか整理する
- Codex と GitHub Copilot CLI の agent / skill の違いを設計として吸収する
- provider 専用実装にする部分と共通 UI にできる部分を明確にする

## Sources

### Codex

- OpenAI Developers: Slash commands in Codex CLI
  - <https://developers.openai.com/codex/cli/slash-commands>
- OpenAI Developers: Agent Skills
  - <https://developers.openai.com/codex/skills>

### GitHub Copilot

- GitHub Docs: Invoking custom agents
  - <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-agents/invoke-custom-agents>
- GitHub Docs: CLI command reference
  - <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
- GitHub Docs: About agent skills
  - <https://docs.github.com/en/copilot/concepts/agents/about-agent-skills>
- GitHub Docs: About CLI plugins
  - <https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins>

## Findings

### 1. Codex の `agent` は custom agent 選択ではなく thread / subagent 切替寄り

- Codex CLI の `/agent` は、slash command docs では「Switch the active agent thread」と説明されている
- つまり Codex の `/agent` は Copilot の custom agent selector とは意味が違う
- WithMate で Copilot の `/agent` と同じ UI に束ねるのは不自然

### 2. Codex の `skill` は slash command ではなく skill mention

- Codex skills docs では、skill の明示呼び出しは CLI / IDE で `/skills` または `$` mention と説明されている
- Codex は `skill-name` を prompt に直接 mention して explicit invocation できる
- したがって WithMate の `/skill` は、Codex へは slash command passthrough ではなく skill mention 生成として実装するのが自然

### 3. Copilot の `/agent` は custom agent selector

- Copilot CLI docs では `/agent` で custom agent を選択できる
- custom agent は `~/.copilot/agents` や `.github/agents` の `.agent.md` から構成され、明示 prompt でも `Use the refactoring agent ...` のように呼べる
- さらに `copilot --agent=...` の programmatic 指定もある

### 4. Copilot の skill は open skill standard だが slash command 主体ではない

- Copilot docs では skills は open standard の skill folder として扱われる
- `Invoking custom agents` では `Use skills` が説明されるが、skill 専用の slash command は主導線として示されていない
- `CLI command reference` の `/skills` は skills 自体の管理 command であり、「今この prompt でこの skill を使う」こととは少し違う
- したがって Copilot でも skill 選択 UI を作るなら、slash passthrough より prompt-level explicit invocation に寄せる方が安定する

### 5. skills は両 provider で共通 protocol に近い

- Codex skills docs は open agent skills standard を明示している
- Copilot の `About agent skills` でも skills は open standard と説明されている
- そのため skill catalog / skill picker / metadata 表示は WithMate で共通化しやすい

## Design Conclusion

### `/agent` は provider 専用実装

- Codex
  - `/agent` は subagent thread switch としてのみ意味を持つ
  - WithMate で初期実装対象にしない
- Copilot
  - `/agent` は custom agent selector として意味がある
  - Copilot provider 選択時だけ有効にする

結論:

- `/agent` は共通 command にしない
- `provider = copilot` のときだけ有効化する provider-specific command とする

### `/skill` は共通 UI にできる

- `/skill` は WithMate 独自 canonical command として定義する
- command 実行時は provider 共通の skill picker を開く
- picker では skill metadata を共通表示する
  - `name`
  - `description`
  - scope
  - source path

ただし、選択後の挙動は provider ごとに分ける。

#### Codex

- prompt に `$skill-name` を挿入する
- 追加の自然言語は不要
- 例:
  - `$skill-creator`
  - `$docs-sync`

#### Copilot

- prompt に自然言語 directive を挿入する
- 例:
  - `Use the skill "docs-sync" for this task.`
  - `Use the skill "api-design-review" before editing code.`
- 将来的に Copilot 側でより direct な skill invocation が docs で確定したら切り替える

## Canonical Commands

WithMate では次を canonical にする。

- `/skill`
  - 共通 command
- `/agent`
  - Copilot provider でのみ有効

alias:

- Codex の `$` mention は `/skill` 実行結果として生成する
- Copilot の `/skills` は skill management command なので、初期実装では別扱いにする

## Initial UX

### `/skill`

1. user が `/skill` を入力する
2. WithMate が skill picker を開く
3. skill を選択する
4. provider ごとの prompt snippet を composer に挿入する
5. user はそのまま続けて自然言語を入力できる

この方式なら、

- skill catalog UI は共通化できる
- provider 差は injection strategy だけに閉じる
- slash command 実装が SDK 依存にならない

### `/agent`

1. `provider = copilot` なら custom agent picker を開く
2. 選んだ agent を session metadata に保持する
3. 次回 turn 実行時に Copilot adapter が provider-native 指定へ変換する

Codex では:

- `/agent` を hidden にするか
- `未対応: Codex では agent thread 切替に相当し、WithMate では未実装` と返す

## Non-Goals

- Codex の `/agent` thread switch を WithMate に再現する
- Copilot CLI の `/skills` 管理画面を完全再現する
- skill 実行可否の provider-native 判定を app 側で持つ

## Recommendation

- `/agent` は共通化しない
- `/skill` は共通化する
- 共通化対象は picker と metadata 表示
- provider 専用化対象は選択後の injection と session metadata mapping
