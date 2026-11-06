/**
 * Pure parsing/serialisation of markdown checkbox lines.
 *
 * Line format:
 *   <indent>- [ ] Task text %%td:6Xg4Qm2pR%% 📅 2026-11-10
 *
 * - `%%td:<id>%%`      Todoist task id (Obsidian comment, hidden in reading view).
 *                      `%%td:new-<uuid>%%` marks a task whose creation is in flight. Written after
 *                      the task's text and before its fields: the Tasks plugin reads fields from the
 *                      end of the line and stops at anything it doesn't know, such as the marker.
 * - `📅 YYYY-MM-DD`    optional due date (Tasks-plugin compatible).
 * - Tasks-plugin fields (`⏳ 🛫 ➕ ✅ ❌` dates, `🔁` repeats, `🔺 ⏫ 🔼 🔽 ⏬` priorities,
 *                      `🆔 ⛔ 🏁`) and a `^block-link` at the end stay on the line, out of the
 *                      Todoist title. Written in the order Tasks writes them.
 * - Status: `[x]`, `[X]` (done) and `[-]` (cancelled) complete the Todoist task. Any other
 *                      status, such as Tasks' `[/]` (in progress), leaves it open. New Todoist
 *                      tasks are made only from `[ ]` and `[/]`.
 * - `#notodoist`       opt this line out of syncing.
 * - `#[Project name]`  file the task in that Todoist project (created if missing).
 *                      Stripped from the line once Todoist has applied it; the chip shows the project.
 * - `@label`, `@[Label name]`  add that Todoist label to the task (created if missing). Stripped
 *                      once applied, like a project reference; the chip shows the task's labels.
 * - `p1` … `p4`        set the task's Todoist priority (p1 = urgent, p4 = none). A separate word;
 *                      the last one wins. Stripped once applied; the chip shows the priority.
 * - `today`, `friday`, `next week`, `every monday`, `15/11` ...  a due date in words (see
 *                      DUE_WORDS_RE_G). Todoist works out the date; once it's pulled back, the
 *                      words are replaced on the line by `📅 YYYY-MM-DD`.
 */

export interface TaskFields {
  text: string;
  checked: boolean;
  due: string | null; // YYYY-MM-DD
}

export interface ParsedTask extends TaskFields {
  /** Everything before the checkbox: indentation and list marker, e.g. "  - ". */
  prefix: string;
  /** Raw char inside the brackets (" ", "x", "X", "/", "-", ...). */
  status: string;
  /**
   * Everything after the checkbox except the marker, the `📅` date, other Tasks fields and a block
   * link: references included, spaces collapsed.
   */
  content: string;
  /** Real Todoist id, or null. */
  todoistId: string | null;
  /** Pending creation uuid (from `%%td:new-<uuid>%%`), or null. */
  pendingUuid: string | null;
  excluded: boolean;
  /** Project named by a `#[Project name]` reference on the line, or null. The last one wins. */
  projectRef: string | null;
  /** Labels named by `@label` / `@[Label name]` references on the line, in order, without duplicates. */
  labelRefs: string[];
  /** Priority from a `p1`–`p4` word on the line, as written (1 = p1, urgent), or null. The last one wins. */
  priorityRef: number | null;
  /** Due date in words (`next friday`, `15/11`, ...), as written, or null. The last one wins. */
  dueRef: string | null;
  /** Tasks-plugin fields other than the due date, as on the line. Missing means none. */
  fields?: TasksFields;
  /** A block link at the end of the line (`^abc`), without the `^`, or null. */
  blockLink?: string | null;
}

/** Tasks-plugin fields other than the due date. Values as Tasks writes them, after the emoji. */
export interface TasksFields {
  id?: string;
  dependsOn?: string;
  /** The emoji itself: 🔺 ⏫ 🔼 🔽 ⏬. */
  priority?: string;
  recurrence?: string;
  onCompletion?: string;
  created?: string;
  start?: string;
  scheduled?: string;
  cancelled?: string;
  done?: string;
}

type FieldKey = keyof TasksFields | "due";

/** Optional variation selector after an emoji. */
const VS = "\uFE0F?";
const field = (key: FieldKey, emoji: string, value: string, write: (v: string) => string) => ({
  key,
  re: new RegExp(`\\s*(?:${emoji})${VS}${value}`, "gu"),
  write,
});
const dateField = (key: FieldKey, emoji: string, sign: string) =>
  field(key, emoji, "\\s*(\\d{4}-\\d{2}-\\d{2})", (v) => `${sign} ${v}`);
/** Tasks' fields, in the order Tasks writes them after the description. */
const FIELDS = [
  field("id", "🆔", "\\s*([A-Za-z0-9_-]+)", (v) => `🆔 ${v}`),
  field("dependsOn", "⛔", "\\s*([A-Za-z0-9_-]+(?:\\s*,\\s*[A-Za-z0-9_-]+)*)", (v) => `⛔ ${v}`),
  field("priority", "", `(🔺|⏫|🔼|🔽|⏬)${VS}`, (v) => v),
  field("recurrence", "🔁", "\\s*([A-Za-z0-9, !]*[A-Za-z0-9!])", (v) => `🔁 ${v}`),
  field("onCompletion", "🏁", "\\s*([Dd]elete|[Kk]eep)", (v) => `🏁 ${v.toLowerCase()}`),
  dateField("created", "➕", "➕"),
  dateField("start", "🛫", "🛫"),
  dateField("scheduled", "⏳|⌛", "⏳"),
  dateField("due", "📅|📆|🗓", "📅"),
  dateField("cancelled", "❌", "❌"),
  dateField("done", "✅", "✅"),
];
const BLOCK_LINK_RE = /(?:^|\s)\^([A-Za-z0-9-]+)$/;
/** Statuses that complete the Todoist task: done and cancelled. */
const CLOSED_STATUSES = "xX-";
/** Statuses an unsynced line can start a Todoist task from: to do, and Tasks' in progress. */
const OPEN_STATUSES = " /";

/** Whether a checkbox status completes the Todoist task. */
export function isClosedStatus(status: string): boolean {
  return status.length === 1 && CLOSED_STATUSES.includes(status);
}

/** Whether an unsynced line with this status, and not opted out, becomes a Todoist task. */
export function createsTask(task: Pick<ParsedTask, "status" | "excluded" | "todoistId" | "pendingUuid">): boolean {
  return !task.excluded && !task.todoistId && !task.pendingUuid && task.status.length === 1 && OPEN_STATUSES.includes(task.status);
}

const CHECKBOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]\s?(.*)$/;
const MARKER_RE = /\s*%%td:([A-Za-z0-9_-]+)%%/;
const MARKER_RE_G = /\s*%%td:[A-Za-z0-9_-]+%%/g;
const OPT_OUT_RE = /(^|\s)#notodoist(\s|$)/;
const PROJECT_RE_G = /(^|\s)#\[([^\]\n]*)\]/g;
/**
 * `@[Any name]`, or `@name` without spaces or brackets. A bare name can't end in punctuation, so
 * "call @Sarah." keeps its full stop. Only at line start or after a space, so emails don't match.
 */
const LABEL_RE_G = /(^|\s)@(?:\[([^\]\n]*)\]|([^\s@[\]#()]*[^\s@[\]#().,;:!?'"]))/g;
/** `p1`–`p4` as a word of its own (not `mp3`, `p1st` or `#p1`). */
const PRIORITY_RE_G = /(^|\s)[pP]([1-4])(?=\s|$)/g;
const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
/**
 * Due dates in words, each a phrase of its own: `today`, `tomorrow`, a weekday (optionally after
 * `next`), `next week`, `every day|weekday|week|month|year|<weekday>`, and `dd/mm`, `dd/mm/yy`,
 * `dd/mm/yyyy`. Todoist works out the actual date. Weekdays are full names only, since "sun",
 * "sat" and "wed" are ordinary words. Ends at a space, the end of the line, or `.,;!?`.
 */
const DUE_WORDS_RE_G = new RegExp(
  "(^|\\s)(" +
    `every\\s+(?:day|weekday|week|month|year|${WEEKDAY})` +
    `|next\\s+(?:week|${WEEKDAY})` +
    `|today|tomorrow|${WEEKDAY}` +
    "|(?:0?[1-9]|[12]\\d|3[01])/(?:0?[1-9]|1[0-2])(?:/(?:\\d{4}|\\d{2}))?" +
    ")(?=[\\s.,;!?]|$)",
  "gi",
);
/** Names that must be written in the bracketed form. */
const LABEL_NEEDS_BRACKETS = /[\s@[\]#()]|[.,;:!?'"]$/;
const PENDING_PREFIX = "new-";

export function parseTaskLine(line: string): ParsedTask | null {
  const m = CHECKBOX_RE.exec(line);
  if (!m) return null;
  const [, prefix, status, rest] = m;

  const marker = MARKER_RE.exec(rest);
  const markerId = marker ? marker[1] : null;

  // Last one wins, as in Tasks, which reads from the end of the line.
  let s = rest.replace(MARKER_RE_G, " ");
  let due: string | null = null;
  const fields: TasksFields = {};
  for (const f of FIELDS) {
    s = s.replace(f.re, (_m, v: string) => {
      if (f.key === "due") due = v;
      else fields[f.key] = v;
      return " ";
    });
  }
  let content = normalize(s);
  const block = BLOCK_LINK_RE.exec(content);
  if (block) content = content.slice(0, block.index).trimEnd();
  const refs = readRefs(content);
  return {
    prefix,
    status,
    content,
    ...refs,
    checked: isClosedStatus(status),
    due,
    fields,
    blockLink: block ? block[1] : null,
    todoistId: markerId && !markerId.startsWith(PENDING_PREFIX) ? markerId : null,
    pendingUuid: markerId && markerId.startsWith(PENDING_PREFIX) ? markerId.slice(PENDING_PREFIX.length) : null,
    excluded: isExcluded(refs.text),
  };
}

type Refs = Pick<ParsedTask, "text" | "projectRef" | "labelRefs" | "priorityRef" | "dueRef">;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const isExcluded = (text: string) => OPT_OUT_RE.test(text) || text.length === 0;

/**
 * Split references out of a line's content, leaving the task text. Each kind is read from what's
 * left once the previous kinds are removed, so a bracketed name like `#[Phase p1]` or
 * `@[Errands @home]` doesn't also count as something else.
 */
function readRefs(content: string): Refs {
  let s = content;
  let projectRef: string | null = null;
  for (const p of s.matchAll(PROJECT_RE_G)) projectRef = p[2].trim() || projectRef;
  s = s.replace(PROJECT_RE_G, "$1");
  const labelRefs: string[] = [];
  for (const l of s.matchAll(LABEL_RE_G)) {
    const name = (l[2] ?? l[3]).trim();
    if (name && !labelRefs.some((x) => x.toLowerCase() === name.toLowerCase())) labelRefs.push(name);
  }
  s = s.replace(LABEL_RE_G, "$1");
  let priorityRef: number | null = null;
  for (const p of s.matchAll(PRIORITY_RE_G)) priorityRef = Number(p[2]);
  s = s.replace(PRIORITY_RE_G, "$1");
  let dueRef: string | null = null;
  for (const d of s.matchAll(DUE_WORDS_RE_G)) dueRef = normalize(d[2]);
  const text = normalize(s.replace(DUE_WORDS_RE_G, "$1"));
  return { text, projectRef, labelRefs, priorityRef, dueRef };
}

/**
 * Re-read a synced task's line knowing its title as last synced with Todoist. Words that are part
 * of that title stay part of it: "Call Bob today" from Todoist is a title, not a task due today.
 * Only what follows the title (typically references typed after it) is read for references. A
 * line whose title was edited in the middle is read in full, as `parseTaskLine` does.
 */
export function withTitle(task: ParsedTask, title: string | undefined): ParsedTask {
  if (!title) return task;
  const t = normalize(title);
  if (task.content === t) {
    return { ...task, text: t, projectRef: null, labelRefs: [], priorityRef: null, dueRef: null, excluded: isExcluded(t) };
  }
  if (!task.content.startsWith(t + " ")) return task;
  const tail = readRefs(task.content.slice(t.length + 1));
  const text = normalize(`${t} ${tail.text}`);
  return { ...task, ...tail, text, excluded: isExcluded(text) };
}

export function markerFor(task: Pick<ParsedTask, "todoistId" | "pendingUuid">): string | null {
  if (task.todoistId) return `%%td:${task.todoistId}%%`;
  if (task.pendingUuid) return `%%td:${PENDING_PREFIX}${task.pendingUuid}%%`;
  return null;
}

/**
 * Serialise a task back to a line: text, references, marker, then the Tasks fields and block link.
 * Keeps the prefix, and a status that still says the same: `[-]` stays while the task is still
 * closed, `[/]` while it's still open.
 */
export function serializeTask(task: ParsedTask): string {
  const closed = isClosedStatus(task.status);
  const status = task.checked ? (closed ? task.status : "x") : closed ? " " : task.status;
  let out = `${task.prefix}[${status}] ${task.text}`;
  if (task.priorityRef) out += ` p${task.priorityRef}`;
  if (task.dueRef) out += ` ${task.dueRef}`;
  for (const l of task.labelRefs) out += ` ${labelRef(l)}`;
  if (task.projectRef) out += ` #[${task.projectRef}]`;
  const marker = markerFor(task);
  if (marker) out += ` ${marker}`;
  for (const f of FIELDS) {
    const v = f.key === "due" ? task.due : task.fields?.[f.key];
    if (v) out += ` ${f.write(v)}`;
  }
  if (task.blockLink) out += ` ^${task.blockLink}`;
  return out;
}

/**
 * Whether a line has its marker last, after fields or a block link, as lines were written before
 * the marker moved. Tasks can't read those fields until the line is rewritten.
 */
export function needsRelayout(line: string, task: ParsedTask): boolean {
  if (!/%%td:[A-Za-z0-9_-]+%%\s*$/.test(line)) return false;
  return !!task.due || !!task.blockLink || Object.values(task.fields ?? {}).some(Boolean);
}

/** How a label is written on a line: `@name`, or `@[Label name]` when the name needs it. */
export function labelRef(name: string): string {
  return LABEL_NEEDS_BRACKETS.test(name) ? `@[${name}]` : `@${name}`;
}

export interface TaskLocation {
  line: number;
  task: ParsedTask;
}

/** Find all checkbox lines in a file, skipping frontmatter and fenced code blocks. */
export function findTasks(content: string): TaskLocation[] {
  const lines = content.split("\n");
  const out: TaskLocation[] = [];
  let i = 0;

  if (lines[0]?.trim() === "---") {
    for (i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        i++;
        break;
      }
    }
  }

  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const f = fenceMatch[1];
      if (fence === null) fence = f[0].repeat(f.length);
      else if (f[0] === fence[0] && f.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const task = parseTaskLine(line);
    if (task) out.push({ line: i, task });
  }
  return out;
}

/** Width of a line's indentation, a tab counting as 4 columns. */
export function indentWidth(line: string): number {
  let w = 0;
  for (const c of /^\s*/.exec(line)![0]) w += c === "\t" ? 4 - (w % 4) : 1;
  return w;
}

/**
 * The checkbox a task line is nested under: the nearest earlier non-blank line that's indented
 * less, if it's one of `taskLines` (a checkbox outside code and frontmatter). Null for a line
 * that isn't indented, or whose nearest less-indented line is a plain bullet, heading or text.
 */
export function parentLine(lines: string[], line: number, taskLines: Set<number>): number | null {
  const width = indentWidth(lines[line]);
  if (width === 0) return null;
  for (let j = line - 1; j >= 0; j--) {
    if (!lines[j].trim()) continue;
    if (indentWidth(lines[j]) < width) return taskLines.has(j) ? j : null;
  }
  return null;
}

/**
 * The last line of the block nested under line `idx` (its subtasks, their subtasks, and any
 * indented text), or `idx` itself if nothing is nested under it. Trailing blank lines aren't part of it.
 */
export function blockEnd(lines: string[], idx: number): number {
  const width = indentWidth(lines[idx]);
  let last = idx;
  for (let j = idx + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    if (indentWidth(lines[j]) <= width) break;
    last = j;
  }
  return last;
}

/** Find the line index that carries a given marker id (real or pending). */
export function findLineByMarker(lines: string[], markerId: string): number {
  const needle = `%%td:${markerId}%%`;
  return lines.findIndex((l) => l.includes(needle));
}

export const PENDING = PENDING_PREFIX;

/** The line with `#[name]` added just before its marker, where sync reads it as a project reference. */
export function withProjectRef(line: string, name: string): string {
  return withRef(line, `#[${name}]`);
}

/** The line with a reference (`#[Project]`, `p2`) added just before its marker, where sync reads it. */
export function withRef(line: string, ref: string): string {
  const marker = /\s*%%td:[A-Za-z0-9_-]+%%/.exec(line);
  const at = marker ? marker.index : line.trimEnd().length;
  return `${line.slice(0, at)} ${ref}${line.slice(at)}`;
}

/**
 * The line after the label picker opened from the `@` at `at` closed: the `@` replaced by
 * references to the added labels, and references to the labels `drop` names taken out. Returns the
 * line and where the cursor goes: after the new references, ready to keep typing.
 */
export function withPickedLabels(line: string, at: number, add: string[], drop: (name: string) => boolean): { line: string; cursor: number } {
  const strip = (s: string) => s.replace(LABEL_RE_G, (m, _pre, bracketed, word) => (drop(String(bracketed ?? word).trim()) ? "" : m));
  let before = strip(line.slice(0, at));
  let after = strip(line.slice(at + 1));
  let refs = add.map(labelRef).join(" ");
  if (refs && !/^\s/.test(after)) refs += " "; // a space after the references, to keep typing
  if (!refs && !after.trim()) before = before.trimEnd(); // the `@` ended the line: no space left behind
  else if (!refs && /\s$/.test(before)) after = after.replace(/^\s+/, ""); // no double space where the `@` was
  return { line: before + refs + after, cursor: before.length + refs.length };
}

const CHECKBOX_PREFIX_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[.\]/;

/**
 * Whether the `@` at `ch` in `line` starts a label: on a checkbox line that syncs, after the
 * checkbox, as a word of its own (after a space, with a space or the end of the line after it),
 * so an email address or `name@` doesn't open the picker.
 */
export function startsLabel(line: string, ch: number): boolean {
  if (line.charAt(ch) !== "@") return false;
  const task = parseTaskLine(line);
  if (!task || /(^|\s)#notodoist(\s|$)/.test(line)) return false;
  if (!task.todoistId && !task.pendingUuid && !createsTask(task)) return false; // never syncs, so a label means nothing
  if (ch < (CHECKBOX_PREFIX_RE.exec(line)?.[0].length ?? 0)) return false;
  return /\s/.test(line.charAt(ch - 1)) && (ch + 1 === line.length || /\s/.test(line.charAt(ch + 1)));
}
