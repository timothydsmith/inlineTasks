import { indentWidth, parseTaskLine, serializeTask } from "../parse/taskLine";
import { dueDate, type TodoistItem } from "../todoist/client";

/**
 * Lines for importing an existing Todoist task into a note: the task, then (unless `withSubtasks`
 * is false) its open subtasks beneath it, each level indented one `tab` further, in Todoist's
 * order. Subtasks already linked to a line elsewhere are left out, with their own subtasks.
 */
export function importLines(
  root: TodoistItem,
  open: TodoistItem[],
  isLinked: (id: string) => boolean,
  indent: string,
  tab: string,
  withSubtasks = true,
): { lines: string[]; items: TodoistItem[] } {
  if (!withSubtasks) return { lines: [taskLine(root, indent)], items: [root] };
  const children = new Map<string, TodoistItem[]>();
  for (const it of open) {
    if (!it.parent_id) continue;
    children.set(it.parent_id, [...(children.get(it.parent_id) ?? []), it]);
  }
  const lines: string[] = [];
  const items: TodoistItem[] = [];
  const add = (item: TodoistItem, depth: number, seen: Set<string>) => {
    if (seen.has(item.id) || depth > 20) return; // guard against a malformed tree
    seen.add(item.id);
    lines.push(taskLine(item, indent + tab.repeat(depth)));
    items.push(item);
    const kids = (children.get(item.id) ?? []).filter((k) => !isLinked(k.id));
    kids.sort((a, b) => (a.child_order ?? 0) - (b.child_order ?? 0));
    for (const k of kids) add(k, depth + 1, seen);
  };
  add(root, 0, new Set());
  return { lines, items };
}

/**
 * Lines for a synced task's open subtasks that aren't in any note yet, each with its own open
 * subtasks, in Todoist's order: to go beneath the task's line, one `tab` deeper than `indent`.
 */
export function missingSubtaskLines(
  parentId: string,
  open: TodoistItem[],
  isLinked: (id: string) => boolean,
  indent: string,
  tab: string,
): { lines: string[]; items: TodoistItem[] } {
  const kids = open
    .filter((i) => i.parent_id === parentId && !isLinked(i.id))
    .sort((a, b) => (a.child_order ?? 0) - (b.child_order ?? 0));
  const lines: string[] = [];
  const items: TodoistItem[] = [];
  for (const kid of kids) {
    const sub = importLines(kid, open, isLinked, indent + tab, tab);
    lines.push(...sub.lines);
    items.push(...sub.items);
  }
  return { lines, items };
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

/** One task as a checkbox line: its title, `📅` due date and marker. */
export function taskLine(item: TodoistItem, indent: string): string {
  return serializeTask({
    prefix: `${indent}- `,
    status: " ",
    content: "",
    text: item.content.replace(/\s+/g, " ").trim(),
    checked: false,
    due: dueDate(item.due),
    todoistId: item.id,
    pendingUuid: null,
    excluded: false,
    projectRef: null,
    labelRefs: [],
    priorityRef: null,
    dueRef: null,
  });
}

/** The title an imported line will be read as, used as its merge base. */
export function lineTitle(line: string): string {
  return parseTaskLine(line)?.content ?? "";
}
