/**
 * `inlineTasks.isCopy(task)`, for the Tasks plugin's `filter by function`, so a query can list each
 * Todoist task once, at its home:
 *
 *     filter by function !inlineTasks.isCopy(task)
 */
import type { SyncState } from "../sync/state";

const MARKER_RE = /%%td:([A-Za-z0-9_-]+)%%/;

/** The parts of a task, in a Tasks query or Tasks' cache, used here. */
export interface TasksQueryTask {
  originalMarkdown: string;
  path: string;
  lineNumber: number;
}

/**
 * Build `isCopy`: true for a line of a synced task that isn't where it lives, being in another note
 * than its home, or after its first line in the home note. False for lines without a marker, and
 * for tasks this device doesn't sync.
 */
export function copyChecker(getState: () => SyncState, getTasks: () => readonly TasksQueryTask[] | null) {
  // The first line of each task in each note, from Tasks' cache, rebuilt when the cache changes.
  let indexed: { tasks: readonly TasksQueryTask[]; length: number; first: Map<string, number> } | null = null;
  const firstLine = (id: string, path: string): number | undefined => {
    const tasks = getTasks();
    if (!tasks) return undefined;
    if (!indexed || indexed.tasks !== tasks || indexed.length !== tasks.length) {
      const first = new Map<string, number>();
      for (const t of tasks) {
        const m = MARKER_RE.exec(t.originalMarkdown);
        if (!m) continue;
        const key = `${t.path}\n${m[1]}`;
        const seen = first.get(key);
        if (seen === undefined || t.lineNumber < seen) first.set(key, t.lineNumber);
      }
      indexed = { tasks, length: tasks.length, first };
    }
    return indexed.first.get(`${path}\n${id}`);
  };

  return (task: TasksQueryTask): boolean => {
    const id = MARKER_RE.exec(task?.originalMarkdown ?? "")?.[1];
    if (!id) return false;
    const rec = getState().tasks[id];
    if (!rec) return false;
    if (task.path !== rec.path) return true;
    const first = firstLine(id, task.path);
    return first !== undefined && task.lineNumber > first;
  };
}
