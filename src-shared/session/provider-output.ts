import { z } from "zod";

/** テキストは Message.text に一度だけ保存し、出力単位はその UTF-16 範囲を参照する。 */
export const providerOutputSchema = z.object({
  units: z.array(
    z.object({
      id: z.string(),
      messageId: z.string().optional(),
      blockIndex: z.number().int().nonnegative().optional(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      role: z.enum(["progress", "answer", "unclassified"]),
      phase: z.string().nullable(),
      completion: z.enum(["complete", "partial", "streaming", "unknown"]),
      final: z.boolean(),
      evidence: z.string().nullable(),
    }),
  ),
  finality: z.enum(["identified", "none", "unknown"]),
});
/** 保存済みの本文に対応する出力単位の範囲と、最終回答を識別できたかを表す。 */
export type ProviderOutput = z.infer<typeof providerOutputSchema>;
/** 本文の結合・整形前の出力単位。範囲の代わりに断片の文字列を持つ。 */
export type ProviderOutputTextUnit = Omit<
  ProviderOutput["units"][number],
  "start" | "end"
> & { text: string };

/** 出力断片を順に結び、整形後の本文に対する範囲と最終性を返す。 */
export function projectProviderOutput(
  units: ProviderOutputTextUnit[],
  finality: ProviderOutput["finality"],
  sanitize: (text: string) => string = (text) => text,
  separator:
    | string
    | ((
        previous: ProviderOutputTextUnit | undefined,
        current: ProviderOutputTextUnit,
      ) => string) = "\n\n",
): { assistantText: string; output: ProviderOutput } {
  let text = "";
  const ranges: ProviderOutput["units"] = [];
  let previous: ProviderOutputTextUnit | undefined;
  for (const unit of units) {
    if (text && unit.text)
      text +=
        typeof separator === "string" ? separator : separator(previous, unit);
    const start = sanitize(text).length;
    text += unit.text;
    const { text: _text, ...metadata } = unit;
    ranges.push({
      ...metadata,
      id: sanitize(metadata.id),
      ...(metadata.messageId !== undefined
        ? { messageId: sanitize(metadata.messageId) }
        : {}),
      phase: metadata.phase === null ? null : sanitize(metadata.phase),
      evidence: metadata.evidence === null ? null : sanitize(metadata.evidence),
      start,
      end: sanitize(text).length,
    });
    previous = unit;
  }
  return { assistantText: sanitize(text), output: { units: ranges, finality } };
}

/** 旧データの出力情報の不在を許し、型や順序・重なり・本文の境界が不正なら拒否する。 */
export function normalizeProviderOutput(
  value: unknown,
  text: string,
): ProviderOutput | undefined {
  if (value === undefined) return undefined;
  const parsed = providerOutputSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.units.some(
      (unit, index) =>
        unit.end < unit.start ||
        unit.end > text.length ||
        unit.start < (parsed.data.units[index - 1]?.end ?? 0),
    )
  )
    throw new Error("The saved Provider output ranges are invalid.");
  return parsed.data;
}
