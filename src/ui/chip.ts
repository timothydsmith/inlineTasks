import { setIcon } from "obsidian";
import { PENDING } from "../parse/taskLine";
import { subtaskCount, type SyncState } from "../sync/state";
import { taskUrl } from "../todoist/client";
import { todoistColor } from "../todoist/colors";

// Todoist priority 4 = p1 (urgent) … 1 = p4 (normal)
const PRIORITY_CLASS: Record<number, string> = { 4: "p1", 3: "p2", 2: "p3" };

/**
 * Render the inline chip for a `%%td:<markerId>%%` marker on a line in the note at `path`. On a
 * copy of the task (a line outside its home note), the icon is a house, which opens the home note.
 */
export function renderChip(markerId: string, state: SyncState, path?: string, doc: Document = document): HTMLElement {
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
    return s;
  };

  if (markerId.startsWith(PENDING)) {
    chip.classList.add("is-pending");
    add("inline-tasks-status", "syncing…");
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
    add("inline-tasks-status", "deleted in Todoist");
    chip.title = "This task was deleted in Todoist. Remove the marker to unlink it.";
    return chip;
  }

  if (rec && path && rec.path !== path) {
    icon.classList.add("is-copy");
    setIcon(icon, "house");
    icon.title = `A copy. This task's home is ${rec.path}: click to open it.`;
  }

  if (meta) {
    const project = state.projects[meta.projectId];
    if (project) {
      const s = add("inline-tasks-project", `#${project.name}`);
      s.title = "Click to move it to another project";
      const color = todoistColor(project.color); // the project's colour in Todoist
      if (color) s.style.color = color;
    }
    if (meta.due) {
      const time = meta.dueTime ? ` ${formatTime(meta.dueTime)}` : "";
      const s = add(`inline-tasks-due${isOverdue(meta.due) && !meta.checked ? " is-overdue" : ""}`, formatDue(meta.due) + time + (meta.recurring ? " ↻" : ""));
      s.title = "Click to change its date";
    }
    if (meta.deadline) {
      // Opens the task in Todoist, like the rest of the chip; the line's `📅` is where to change it.
      const s = add(`inline-tasks-deadline${isOverdue(meta.deadline) && !meta.checked ? " is-overdue" : ""}`, "");
      setIcon(s.createSpan(), "target");
      s.createSpan({ text: formatDue(meta.deadline) });
      s.title = `Deadline: ${meta.deadline}`;
    }
    const p = PRIORITY_CLASS[meta.priority];
    if (p) add(`inline-tasks-priority ${p}`, p.toUpperCase()).title = "Click to change its priority";
    const labels = meta.labels ?? [];
    if (labels.length === 1) {
      add("inline-tasks-label", `@${labels[0]}`).title = "Click to change its labels";
    } else if (labels.length > 1) {
      // Two or more: a tag icon and how many, to keep the chip short. Hover lists them.
      const s = add("inline-tasks-label inline-tasks-label-count", "");
      setIcon(s.createSpan(), "tag");
      s.createSpan({ text: String(labels.length) });
      s.title = `${labels.map((l) => `@${l}`).join(" ")}. Click to change them.`;
    }
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

/** A time of day, `HH:MM:SS`, as the device writes times: `2:00 pm` or `14:00`. */
function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
