import { z } from "zod";

/** Text is stored once in Message.text; output units refer to its UTF-16 ranges. */
export const providerOutputSchema = z.object({
  units: z.array(z.object({
    id: z.string(), messageId: z.string().optional(), blockIndex: z.number().int().nonnegative().optional(),
    start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
    role: z.enum(["progress", "answer", "unclassified"]), phase: z.string().nullable(),
    completion: z.enum(["complete", "partial", "streaming", "unknown"]),
    final: z.boolean(), evidence: z.string().nullable(),
  })),
  finality: z.enum(["identified", "none", "unknown"]),
});
export type ProviderOutput = z.infer<typeof providerOutputSchema>;
export type ProviderOutputTextUnit = Omit<ProviderOutput["units"][number], "start" | "end"> & { text: string };

export function projectProviderOutput(units: ProviderOutputTextUnit[], finality: ProviderOutput["finality"], sanitize: (text: string) => string = (text) => text, separator: string | ((previous: ProviderOutputTextUnit | undefined, current: ProviderOutputTextUnit) => string) = "\n\n"): { assistantText: string; output: ProviderOutput } {
  let text = "";
  const ranges: ProviderOutput["units"] = [];
  let previous: ProviderOutputTextUnit | undefined;
  for (const unit of units) {
    if (text && unit.text) text += typeof separator === "string" ? separator : separator(previous, unit);
    const start = sanitize(text).length;
    text += unit.text;
    const { text: _text, ...metadata } = unit;
    ranges.push({ ...metadata, id: sanitize(metadata.id), ...(metadata.messageId !== undefined ? { messageId: sanitize(metadata.messageId) } : {}), phase: metadata.phase === null ? null : sanitize(metadata.phase), evidence: metadata.evidence === null ? null : sanitize(metadata.evidence), start, end: sanitize(text).length });
    previous = unit;
  }
  return { assistantText: sanitize(text), output: { units: ranges, finality } };
}

export function normalizeProviderOutput(value: unknown, text: string): ProviderOutput | undefined {
  if (value === undefined) return undefined;
  const parsed = providerOutputSchema.safeParse(value);
  if (!parsed.success || parsed.data.units.some((unit, index) => unit.end < unit.start || unit.end > text.length || unit.start < (parsed.data.units[index - 1]?.end ?? 0))) throw new Error("The saved Provider output ranges are invalid.");
  return parsed.data;
}
