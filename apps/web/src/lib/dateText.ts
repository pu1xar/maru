const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `Nov 15`: the month and day of a date in local time. */
export function monthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
