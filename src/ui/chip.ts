import { PENDING } from "../parse/taskLine";
import { subtaskCount, type SyncState } from "../sync/state";
import { taskUrl } from "../todoist/client";

// Todoist priority 4 = p1 (urgent) … 1 = p4 (normal)
const PRIORITY_CLASS: Record<number, string> = { 4: "p1", 3: "p2", 2: "p3" };

/** Render the inline chip for a `%%td:<markerId>%%` marker. */
export function renderChip(markerId: string, state: SyncState, doc: Document = document): HTMLElement {
  const chip = doc.createElement("a");
  chip.className = "inline-tasks-chip";
  chip.setAttribute("contenteditable", "false");

  const icon = doc.createElement("span");
  icon.className = "inline-tasks-icon";
  chip.appendChild(icon);

  const add = (cls: string, text: string) => {
    const s = doc.createElement("span");
    s.className = cls;
    s.textContent = text;
    chip.appendChild(s);
  };

  if (markerId.startsWith(PENDING)) {
    chip.classList.add("is-pending");
    add("inline-tasks-label", "syncing…");
    chip.title = "Creating in Todoist";
    return chip;
  }

  const rec = state.tasks[markerId];
  const meta = state.remote[markerId];
  chip.href = taskUrl(markerId);
  chip.target = "_blank";
  chip.rel = "noopener";

  if (rec?.orphaned) {
    chip.classList.add("is-orphaned");
    add("inline-tasks-label", "deleted in Todoist");
    chip.title = "This task was deleted in Todoist. Remove the marker to unlink it.";
    return chip;
  }

  if (meta) {
    const project = state.projects[meta.projectId];
    if (project) {
      add("inline-tasks-project", `#${project.name}`);
      (chip.lastChild as HTMLElement).title = "Click to move it to another project";
    }
    if (meta.due) add(`inline-tasks-due${isOverdue(meta.due) && !meta.checked ? " is-overdue" : ""}`, formatDue(meta.due) + (meta.recurring ? " ↻" : ""));
    const p = PRIORITY_CLASS[meta.priority];
    if (p) add(`inline-tasks-priority ${p}`, p.toUpperCase());
    for (const l of meta.labels ?? []) add("inline-tasks-label", `@${l}`);
    if (meta.checked) chip.classList.add("is-done");
  }
  const subtasks = subtaskCount(state, markerId);
  if (subtasks) {
    add("inline-tasks-subtasks", `↳ ${subtasks}`);
    const n = subtasks === 1 ? "1 open subtask" : `${subtasks} open subtasks`;
    (chip.lastChild as HTMLElement).title = `${n}. Click to add any that aren't in a note yet.`;
  }
  chip.title = "Open in Todoist";
  return chip;
}

function isOverdue(date: string): boolean {
  return date < new Date().toISOString().slice(0, 10);
}

function formatDue(date: string): string {
  const d = new Date(date + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
