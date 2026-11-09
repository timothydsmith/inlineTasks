import { blockEnd, parseTaskLine, serializeTask, withLinePriority, type TasksFields } from "../parse/taskLine";
import { canonicalRule } from "./recurrence";
import { dueDate, type TodoistItem } from "../todoist/client";
import { childLines, compareSiblings } from "./order";

/** Todoist's order for two sibling tasks. */
const byTodoistOrder = (a: TodoistItem, b: TodoistItem) =>
  compareSiblings({ id: a.id, key: a.order_key, childOrder: a.child_order }, { id: b.id, key: b.order_key, childOrder: b.child_order });

/**
 * Lines for importing an existing Todoist task into a note: the task, then (unless `withSubtasks`
 * is false) its open subtasks beneath it, each level indented one `tab` further, in Todoist's
 * order. Subtasks already linked to a line elsewhere are left out, with their own subtasks. With
 * `tasksFields`, each line carries its Todoist priority and repeat as Tasks fields.
 */
export function importLines(
  root: TodoistItem,
  open: TodoistItem[],
  isLinked: (id: string) => boolean,
  indent: string,
  tab: string,
  withSubtasks = true,
  tasksFields = false,
): { lines: string[]; items: TodoistItem[] } {
  if (!withSubtasks) return { lines: [taskLine(root, indent, tasksFields)], items: [root] };
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
    lines.push(taskLine(item, indent + tab.repeat(depth), tasksFields));
    items.push(item);
    const kids = (children.get(item.id) ?? []).filter((k) => !isLinked(k.id)).sort(byTodoistOrder);
    for (const k of kids) add(k, depth + 1, seen);
  };
  add(root, 0, new Set());
  return { lines, items };
}

/**
 * The note's lines with the synced task on line `parentLine` given its open subtasks that aren't
 * in any note yet, each with its own open subtasks, one `tab` deeper than the task. Each goes
 * where Todoist has it: after the nearest subtask before it in Todoist's order that's already
 * under the task here, or first if there's none.
 */
export function withMissingSubtasks(
  lines: string[],
  parentLine: number,
  parentId: string,
  open: TodoistItem[],
  isLinked: (id: string) => boolean,
  tab: string,
  tasksFields = false,
): { lines: string[]; added: { item: TodoistItem; line: string }[] } {
  const indent = /^\s*/.exec(lines[parentLine])![0] + tab;
  const kids = open.filter((i) => i.parent_id === parentId).sort(byTodoistOrder);
  let out = [...lines];
  const added: { item: TodoistItem; line: string }[] = [];
  for (let k = 0; k < kids.length; k++) {
    const kid = kids[k];
    if (isLinked(kid.id)) continue;
    const block = importLines(kid, open, isLinked, indent, tab, true, tasksFields);
    // Where the subtasks before it in Todoist's order are in the note (including ones just added).
    const here = new Map<string, number>();
    for (const l of childLines(out, parentLine)) {
      const id = parseTaskLine(out[l])?.todoistId;
      if (id) here.set(id, l);
    }
    let after = parentLine;
    for (let j = k - 1; j >= 0; j--) {
      const l = here.get(kids[j].id);
      if (l !== undefined) {
        after = blockEnd(out, l);
        break;
      }
    }
    out = [...out.slice(0, after + 1), ...block.lines, ...out.slice(after + 1)];
    block.items.forEach((item, i) => added.push({ item, line: block.lines[i] }));
  }
  return { lines: out, added };
}

/** A Todoist task's priority and repeat as Tasks fields. A repeat Tasks wouldn't understand is left out. */
function importedFields(item: TodoistItem): TasksFields {
  const fields = withLinePriority(undefined, 5 - item.priority);
  const rule = item.due?.is_recurring && item.due.string ? canonicalRule(item.due.string) : undefined;
  if (rule) fields.recurrence = rule;
  return fields;
}

/**
 * One task as a checkbox line: its title, marker, date and deadline, and with `tasksFields` its
 * Tasks priority and repeat.
 */
export function taskLine(item: TodoistItem, indent: string, tasksFields = false): string {
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
    deadline: item.deadline?.date ?? null,
    fields: tasksFields ? importedFields(item) : undefined,
  });
}
