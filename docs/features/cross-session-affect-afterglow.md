# Cross-session Affect afterglow

## 概要

同じCharacterが別Sessionで経験したAffect eventを、現在のSessionへ時間減衰した余韻として投影します。保存済みevent自体を移動または複製せず、contextを読む時点でprojectionを計算します。

## 投影の優先順位

現在のSession内で生じたeventを最優先にします。別Sessionのeventは補助的な余韻として扱い、現在の発言やCharacter Definitionを上書きしません。

session affectとrelationship affectは別々の減衰規則を使用します。relationship layerだから無期限に残る、またはsession layerだから即座に消えるという扱いにはしません。

## read-time計算

余韻の重みは、eventの発生時刻とcontext評価時刻から計算します。保存済みの強度を書き換えず、同じeventでも評価時刻が進むと投影だけが減衰します。

次のeventは防御的に扱います。

- 現在時刻より未来にあるevent
- ageが0のevent
- 保持期間を超えたevent
- 別Characterがownerのevent
- 必要な時刻情報が不正なevent

## source eventの保持

余韻が減衰または解消しても、元のAffect eventを削除しません。別時点のeventを意味の近さだけで統合せず、event historyとして保持します。

## 関連文書

- [ADR 018: Character Affect Event Persistence](../adr/018-character-affect-event-persistence.md)
- [Memory Affect MCP Application Boundary](../adr/020-memory-affect-mcp-application-boundary.md)
