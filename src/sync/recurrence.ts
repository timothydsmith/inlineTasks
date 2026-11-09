/**
 * Repeats: a line's `🔁` rule (the Tasks plugin's) and a Todoist recurring due string, translated
 * both ways. Only rules both understand are translated; anything else stays where it was written.
 *
 * Rules are compared in one canonical form, the way Tasks writes them:
 *   every day | every 2 weeks | every weekday | every week on Monday, Friday
 *   every month on the 15th | every month on the last   (each optionally `… when done`)
 */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
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
  if (onDays) body = onDays[1].toLowerCase();
  else if (onDate) body = onDate[1];
  else if (body === "month on the last") body = "last day";
  return `${every} ${body}`;
}
