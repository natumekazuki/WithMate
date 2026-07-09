function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTimestampLabel(value: Date | string | number): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return typeof value === "string" && value.trim() ? value : "";
  }

  const year = timestamp.getFullYear();
  const month = padDatePart(timestamp.getMonth() + 1);
  const day = padDatePart(timestamp.getDate());
  const hours = padDatePart(timestamp.getHours());
  const minutes = padDatePart(timestamp.getMinutes());
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

export function currentTimestampLabel(): string {
  return formatTimestampLabel(new Date());
}

export function currentIsoTimestamp(): string {
  return new Date().toISOString();
}
