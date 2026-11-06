/**
 * Pure parsing/serialisation of markdown checkbox lines.
 *
 * Line format:
 *   <indent>- [ ] Task text 📅 2026-11-10 %%td:6Xg4Qm2pR%%
 *
 * - `%%td:<id>%%`      Todoist task id (Obsidian comment, hidden in reading view).
 *                      `%%td:new-<uuid>%%` marks a task whose creation is in flight.
 * - `📅 YYYY-MM-DD`    optional due date (Tasks-plugin compatible).
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
  /** Everything after the checkbox except the marker and `📅` date, references included, spaces collapsed. */
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
}

const CHECKBOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]\s?(.*)$/;
const MARKER_RE = /\s*%%td:([A-Za-z0-9_-]+)%%/;
const MARKER_RE_G = /\s*%%td:[A-Za-z0-9_-]+%%/g;
const DUE_RE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const DUE_RE_G = /\s*📅\s*\d{4}-\d{2}-\d{2}/g;
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
  const due = DUE_RE.exec(rest);

  const content = normalize(rest.replace(MARKER_RE_G, "").replace(DUE_RE_G, ""));
  const refs = readRefs(content);
  return {
    prefix,
    status,
    content,
    ...refs,
    checked: status !== " ",
    due: due ? due[1] : null,
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

/** Serialise a task back to a line. Preserves prefix and non-standard statuses when still checked. */
export function serializeTask(task: ParsedTask): string {
  const status = task.checked ? (task.status !== " " ? task.status : "x") : " ";
  let out = `${task.prefix}[${status}] ${task.text}`;
  if (task.priorityRef) out += ` p${task.priorityRef}`;
  if (task.dueRef) out += ` ${task.dueRef}`;
  for (const l of task.labelRefs) out += ` ${labelRef(l)}`;
  if (task.projectRef) out += ` #[${task.projectRef}]`;
  if (task.due) out += ` 📅 ${task.due}`;
  const marker = markerFor(task);
  if (marker) out += ` ${marker}`;
  return out;
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

/** Find the line index that carries a given marker id (real or pending). */
export function findLineByMarker(lines: string[], markerId: string): number {
  const needle = `%%td:${markerId}%%`;
  return lines.findIndex((l) => l.includes(needle));
}

export const PENDING = PENDING_PREFIX;
