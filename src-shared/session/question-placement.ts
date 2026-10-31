import type { AssistantQuestionRange, ElicitationRecord } from "./runtime-state.js";

export function placeElicitationRecords(
  records: ElicitationRecord[] | undefined,
  ranges: readonly AssistantQuestionRange[] | undefined,
): ElicitationRecord[] | undefined {
  if (!records || ranges === undefined) return records;
  return records.map((record) => {
    if (!record.sourceItemId) return record;
    const range = ranges.find((entry) => entry.itemId === record.sourceItemId);
    return { ...record, textRange: range ? { start: range.start, end: range.end } : undefined };
  });
}
