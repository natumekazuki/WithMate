/** 日時の数値部分を表示用にゼロ埋めし、最低2桁に揃える。 */
function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

/** 有効な日時をローカル時刻の分精度で表示する。解釈できない入力は空でない元の文字列だけ残す。 */
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

/** 現在のローカル時刻を表示用ラベルとして返す。 */
export function currentTimestampLabel(): string {
  return formatTimestampLabel(new Date());
}

/** 現在時刻をタイムゾーンに依存しないUTCのISO文字列で返す。 */
export function currentIsoTimestamp(): string {
  return new Date().toISOString();
}
