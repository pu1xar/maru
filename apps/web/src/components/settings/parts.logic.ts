// The settings pages' time and size text, apart from the components so the Android app reads it too.

/** `Nov 15 14:03`, with the year when it is not this year. */
import { monthDay } from "../../lib/dateText.ts";
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = monthDay(d);
  return d.getFullYear() === new Date().getFullYear() ? `${md} ${hm}` : `${md}, ${d.getFullYear()} ${hm}`;
}

/** `30.7 MB`: bytes as the file preview, the trash list and the session table write them. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** A byte count as the session table writes it; `-` when the size is not known. */
export function formatSize(n: number | null | undefined): string {
  return n == null ? "-" : formatBytes(n);
}
