// `ps -o lstart` prints local time without a zone. When daylight saving time
// ends, one local hour happens twice, so a start time read in that hour names two
// instants an hour apart. On 2026-11-01 in Toronto, Date.parse read 01:15 as EDT
// while the process had started at 01:15 EST, an hour later. Asking ps for UTC
// gives one instant for every start time.

/** The environment for a `ps -o lstart` call whose output parseStartTime reads.
 * LC_TIME=C keeps English month names. LC_ALL would override it, so its value
 * moves to LC_CTYPE: a command line in the same output keeps its non-ASCII text,
 * which LC_ALL=C would escape. */
export function startTimeEnvironment(env = process.env) {
  const { LC_ALL, ...rest } = env;
  return { ...rest, ...(LC_ALL ? { LC_CTYPE: LC_ALL } : {}), LC_TIME: "C", TZ: "UTC0" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/;

/** Milliseconds since the epoch for a UTC `lstart` value; null for any other text. */
export function parseStartTime(text) {
  const match = typeof text === "string" ? LSTART.exec(text.trim()) : null;
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (month < 0) return null;
  const [day, hours, minutes, seconds, year] = [2, 3, 4, 5, 6].map(index => Number(match[index]));
  const value = Date.UTC(year, month, day, hours, minutes, seconds);
  const date = new Date(value);
  // Date.UTC rolls an impossible date such as Feb 31 into the next month.
  return date.getUTCMonth() === month && date.getUTCDate() === day && hours < 24 && minutes < 60 && seconds < 60
    ? value : null;
}
