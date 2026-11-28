/** 現在のローカル日時を UTC オフセット付きで表す。会話履歴は参照しない。 */
export function formatCurrentDateTime(
  date: Date,
  offsetMinutes = -date.getTimezoneOffset(),
): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  /** 日時の各数値を、年・ミリ秒などの欄に応じた最小桁数でゼロ埋めする。 */
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offset = Math.abs(offsetMinutes);
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `.${pad(shifted.getUTCMilliseconds(), 3)}${offsetMinutes >= 0 ? "+" : "-"}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`
  );
}
