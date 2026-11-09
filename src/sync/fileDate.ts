/**
 * The Tasks plugin's "use filename as scheduled date": a task in a note named for a date, such as
 * a daily note `2026-11-09.md`, without a `⏳`, `📅` or `🛫` date, is scheduled on that date.
 * Read the same way as Tasks reads it, so Todoist gets the date Tasks shows.
 */

/** The Tasks plugin's settings for it. */
export interface FileDateSettings {
  /** Tasks' "use filename as scheduled date" is on. */
  enabled: boolean;
  /** Only notes in these folders (and their subfolders); empty for all. */
  folders: string[];
  /** A moment.js format for the name, tried first; empty for none. */
  format: string;
}

/**
 * The date in a note's name, YYYY-MM-DD, or null: by `format` if it parses the whole name
 * strictly, otherwise the first `YYYY-MM-DD` or `YYYYMMDD` in it. `parse` reads a name with a
 * format (moment.js in Obsidian), giving YYYY-MM-DD or null.
 */
export function fileDate(
  path: string,
  settings: FileDateSettings | null | undefined,
  parse?: (name: string, format: string) => string | null,
): string | null {
  if (!settings?.enabled) return null;
  const folders = settings.folders.map((f) => f.replace(/\/+$/, "")).filter(Boolean);
  if (folders.length && !folders.some((f) => path.startsWith(`${f}/`))) return null;
  const name = path.slice(path.lastIndexOf("/") + 1, path.lastIndexOf(".") < 0 ? undefined : path.lastIndexOf("."));
  if (settings.format && parse) {
    const d = parse(name, settings.format);
    if (d) return d;
  }
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(name) ?? /(\d{4})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
