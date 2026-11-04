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
  /** Real Todoist id, or null. */
  todoistId: string | null;
  /** Pending creation uuid (from `%%td:new-<uuid>%%`), or null. */
  pendingUuid: string | null;
  excluded: boolean;
}

const CHECKBOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]\s?(.*)$/;
const MARKER_RE = /\s*%%td:([A-Za-z0-9_-]+)%%/;
const MARKER_RE_G = /\s*%%td:[A-Za-z0-9_-]+%%/g;
const DUE_RE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const DUE_RE_G = /\s*📅\s*\d{4}-\d{2}-\d{2}/g;
const OPT_OUT_RE = /(^|\s)#notodoist(\s|$)/;
const PENDING_PREFIX = "new-";

export function parseTaskLine(line: string): ParsedTask | null {
  const m = CHECKBOX_RE.exec(line);
  if (!m) return null;
  const [, prefix, status, rest] = m;

  const marker = MARKER_RE.exec(rest);
  const markerId = marker ? marker[1] : null;
  const due = DUE_RE.exec(rest);

  const text = rest.replace(MARKER_RE_G, "").replace(DUE_RE_G, "").replace(/\s+/g, " ").trim();

  return {
    prefix,
    status,
    text,
    checked: status !== " ",
    due: due ? due[1] : null,
    todoistId: markerId && !markerId.startsWith(PENDING_PREFIX) ? markerId : null,
    pendingUuid: markerId && markerId.startsWith(PENDING_PREFIX) ? markerId.slice(PENDING_PREFIX.length) : null,
    excluded: OPT_OUT_RE.test(text) || text.length === 0,
  };
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
  if (task.due) out += ` 📅 ${task.due}`;
  const marker = markerFor(task);
  if (marker) out += ` ${marker}`;
  return out;
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
