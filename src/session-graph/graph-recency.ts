export type SessionGraphRecencyRange = {
  oldestUpdatedAt?: string;
  newestUpdatedAt?: string;
};

const RECENCY_COLORS = [[28, 33, 43], [38, 50, 67], [52, 70, 90]] as const;

export function sessionGraphRecency(
  updatedAt: string | undefined,
  range: SessionGraphRecencyRange,
): { background: string; latest: boolean } {
  if (!updatedAt || !range.oldestUpdatedAt || !range.newestUpdatedAt) {
    return { background: "#1C212B", latest: false };
  }
  const timestamp = Date.parse(updatedAt);
  const oldest = Date.parse(range.oldestUpdatedAt);
  const newest = Date.parse(range.newestUpdatedAt);
  const position = newest === oldest ? 1 : (timestamp - oldest) / (newest - oldest);
  const segment = position <= 0.5 ? 0 : 1;
  const fraction = segment === 0 ? position * 2 : (position - 0.5) * 2;
  const background = "#" + RECENCY_COLORS[segment].map((channel, index) =>
    Math.round(channel + (RECENCY_COLORS[segment + 1][index] - channel) * fraction)
      .toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
  return { background, latest: timestamp === newest };
}
