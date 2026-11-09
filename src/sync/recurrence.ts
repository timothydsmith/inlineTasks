/**
 * Repeats: a line's `🔁` rule (the Tasks plugin's) and a Todoist recurring due string, translated
 * both ways. Only rules both understand are translated; anything else stays where it was written.
 *
 * Rules are compared in one canonical form, the way Tasks writes them:
 *   every day | every 2 weeks | every weekday | every week on Monday, Friday
 *   every month on the 15th | every month on the last   (each optionally `… when done`)
 *   every month on the 2nd Wednesday | every month on the last Friday   (Todoist: every 2nd wed)
 *   every January on the 15th   (Todoist: every jan 15th)
 *   every 2 weeks on Monday   (Todoist: every other monday)
 * The last three have no `when done` form in Todoist.
 */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Days in each month, February in a leap year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const NTH: Record<string, string> = { "1st": "1st", first: "1st", "2nd": "2nd", second: "2nd", "3rd": "3rd", third: "3rd", "4th": "4th", fourth: "4th", last: "last" };
/** Rules Todoist has no `every!` form of. */
const NO_WHEN_DONE = [/^every month on the (?:1st|2nd|3rd|4th|last) [A-Z]/, /^every [A-Z][a-z]+ on the /, /^every 2 weeks on /];
const DAY_RE = [/^mon(day)?$/, /^tue(s(day)?)?$/, /^wed(nesday)?$/, /^thu(r(s(day)?)?)?$/, /^fri(day)?$/, /^sat(urday)?$/, /^sun(day)?$/];
const ALIASES: Record<string, string> = {
  daily: "every day",
  weekly: "every week",
  monthly: "every month",
  yearly: "every year",
  annually: "every year",
  "every workday": "every weekday",
  "every work day": "every weekday",
};

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function dayIndex(word: string): number {
  return DAY_RE.findIndex((re) => re.test(word));
}

/** A month from its name or a 3+ letter start of it ("jan", "sept"), or -1. */
function monthIndex(word: string): number {
  return word.length >= 3 ? MONTHS.findIndex((m) => m.toLowerCase().startsWith(word)) : -1;
}

/**
 * A repeat rule, from a `🔁` or a Todoist due string, in canonical form; undefined if it isn't one
 * both Tasks and Todoist understand the same way. A start, end or time (`starting nov 10`,
 * `at 9am`) is dropped: the line's date carries the start, and times aren't synced.
 */
export function canonicalRule(rule: string): string | undefined {
  let s = rule.toLowerCase().replace(/\s+/g, " ").trim().replace(/,$/, "");
  let whenDone = false;
  // Todoist's `every!` (and `ev!`) counts from the completion, as Tasks' `when done` does.
  s = s.replace(/^ev(?:ery)?\s*!\s*/, () => {
    whenDone = true;
    return "every ";
  });
  s = s.replace(/^ev /, "every ");
  s = s.replace(/ (?:starting|from|until|ending|for|at|@) .*$/, "");
  s = s.replace(/ when done$/, () => {
    whenDone = true;
    return "";
  });
  s = ALIASES[s] ?? s;
  s = s.replace(/^every other /, "every 2 ");
  const out = canonicalBody(s);
  if (out && whenDone && NO_WHEN_DONE.some((re) => re.test(out))) return undefined;
  return out && (whenDone ? `${out} when done` : out);
}

function canonicalBody(s: string): string | undefined {
  if (s === "every weekday") return s;
  let m = /^every (?:(\d+) )?(day|week|month|year)s?$/.exec(s);
  if (m) {
    const n = m[1] ? Number(m[1]) : 1;
    if (n < 1) return undefined;
    return n === 1 ? `every ${m[2]}` : `every ${n} ${m[2]}s`;
  }
  m = /^every (?:week on )?([a-z]+(?:(?:, ?| and |, and )[a-z]+)*)$/.exec(s);
  if (m) {
    const idx = m[1].split(/, and |, ?| and /).map(dayIndex);
    if (idx.some((i) => i < 0)) return undefined;
    const days = [...new Set(idx)].sort((a, b) => a - b).map((i) => DAYS[i]);
    return `every week on ${days.join(", ")}`;
  }
  m = /^every (?:month on (?:the )?(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th))$/.exec(s);
  if (m) {
    const n = Number(m[1] ?? m[2]);
    return n >= 1 && n <= 31 ? `every month on the ${ordinal(n)}` : undefined;
  }
  if (/^every (?:month on the last(?: day)?|last day(?: of the month)?)$/.test(s)) return "every month on the last";
  // The nth weekday of each month: Tasks' "every month on the 2nd Wednesday", Todoist's "every 2nd wed".
  m = /^every (?:month on (?:the )?)?(1st|2nd|3rd|4th|first|second|third|fourth|last) ([a-z]+)$/.exec(s);
  if (m) {
    const day = dayIndex(m[2]);
    return day < 0 ? undefined : `every month on the ${NTH[m[1]]} ${DAYS[day]}`;
  }
  // A date each year: Tasks' "every January on the 15th", Todoist's "every jan 15th" or "every 15 jan".
  let month: string | undefined;
  let date: string | undefined;
  m = /^every (?:year on )?([a-z]+)(?: on the)? (\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
  if (m) [month, date] = [m[1], m[2]];
  m = /^every (?:year on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)$/.exec(s);
  if (m) [month, date] = [m[2], m[1]];
  const i = month ? monthIndex(month) : -1;
  if (i >= 0) {
    const n = Number(date);
    return n >= 1 && n <= MONTH_DAYS[i] ? `every ${MONTHS[i]} on the ${ordinal(n)}` : undefined;
  }
  // Every other week on one day: Tasks' "every 2 weeks on Monday", Todoist's "every other monday".
  m = /^every 2 (?:weeks? on )?([a-z]+)$/.exec(s);
  if (m) {
    const day = dayIndex(m[1]);
    return day < 0 ? undefined : `every 2 weeks on ${DAYS[day]}`;
  }
  return undefined;
}

/** A canonical rule (see canonicalRule) as a Todoist due string. */
export function todoistRule(canonical: string): string {
  let s = canonical;
  let every = "every";
  if (s.endsWith(" when done")) {
    s = s.slice(0, -" when done".length);
    every = "every!";
  }
  let body = s.replace(/^every /, "");
  const onDays = /^week on (.+)$/.exec(body);
  const onDate = /^month on the (\d+(?:st|nd|rd|th))$/.exec(body);
  const nthDay = /^month on the (1st|2nd|3rd|4th|last) ([A-Za-z]+)$/.exec(body);
  const yearly = /^([A-Z][a-z]+) on the (\d+(?:st|nd|rd|th))$/.exec(body);
  const otherWeek = /^2 weeks on ([A-Za-z]+)$/.exec(body);
  if (onDays) body = onDays[1].toLowerCase();
  else if (onDate) body = onDate[1];
  else if (body === "month on the last") body = "last day";
  else if (nthDay) body = `${nthDay[1]} ${nthDay[2].toLowerCase()}`;
  else if (yearly) body = `${yearly[1].slice(0, 3).toLowerCase()} ${yearly[2]}`;
  else if (otherWeek) body = `other ${otherWeek[1].toLowerCase()}`;
  return `${every} ${body}`;
}
