import { parseTaskLine, serializeTask } from "../parse/taskLine";
import { dueDate, type TodoistItem } from "../todoist/client";

/**
 * Lines for importing an existing Todoist task into a note: the task, then its open subtasks
 * beneath it, each level indented one `tab` further, in Todoist's order. Subtasks already linked
 * to a line elsewhere are left out, with their own subtasks.
 */
export function importLines(
  root: TodoistItem,
  open: TodoistItem[],
  isLinked: (id: string) => boolean,
  indent: string,
  tab: string,
): { lines: string[]; items: TodoistItem[] } {
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
