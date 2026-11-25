/**
 * Functions for the Tasks plugin's `filter by function`, `group by function` and `sort by
 * function`, about the Todoist task a line is linked to:
 *
 *     filter by function !inlineTasks.isCopy(task)               each task once, at its home
 *     filter by function inlineTasks.hasLabel(task, "PhoneCall")  its Todoist labels
 *     filter by function inlineTasks.inProject(task, "Work")      its Todoist project, or one under it
 *     group by function inlineTasks.labels(task)
 *     group by function inlineTasks.project(task)
 */
import { splitProjectPath } from "../sync/projects";
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

/** Names compared as Todoist compares them: ignoring case and extra spaces. */
const key = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Build the label and project functions, from this device's details of each Todoist task as of its
 * last pull. A line without a marker, or for a task this device doesn't sync, has no labels and no
 * project.
 */
export function todoistFunctions(getState: () => SyncState) {
  const details = (task: Pick<TasksQueryTask, "originalMarkdown"> | null | undefined) => {
    const id = MARKER_RE.exec(task?.originalMarkdown ?? "")?.[1];
    return id ? getState().remote[id] : undefined;
  };
  /** The project's path, its parents first, as a `#[…]` reference names it: `Work/Clients/Acme`. */
  const projectNames = (projectId: string | undefined): string[] => {
    const state = getState();
    const names: string[] = [];
    for (let id = projectId, guard = 0; id && state.projects[id] && guard < 10; id = state.projects[id].parentId ?? undefined, guard++) {
      names.unshift(state.projects[id].name);
    }
    return names;
  };

  /** The task's Todoist labels, as Todoist spells them. */
  const labels = (task: Pick<TasksQueryTask, "originalMarkdown">): string[] => [...(details(task)?.labels ?? [])];

  /**
   * Whether the task has any of the labels named, ignoring case and a leading `@`; with none named,
   * whether it has any label.
   */
  const hasLabel = (task: Pick<TasksQueryTask, "originalMarkdown">, ...names: string[]): boolean => {
    const own = labels(task).map(key);
    if (!names.length) return own.length > 0;
    return names.some((n) => own.includes(key(String(n).replace(/^@/, ""))));
  };

  /** The task's Todoist project, with its parents: `Work/Clients/Acme`. Empty if not known. */
  const project = (task: Pick<TasksQueryTask, "originalMarkdown">): string => projectNames(details(task)?.projectId).join("/");

  /**
   * Whether the task is in any of the projects named, or a project under one, ignoring case. Name a
   * project by its path, `Work/Clients`, as in a `#[…]` reference; a name alone matches a project
   * of that name anywhere.
   */
  const inProject = (task: Pick<TasksQueryTask, "originalMarkdown">, ...names: string[]): boolean => {
    const own = projectNames(details(task)?.projectId).map(key);
    return names.some((n) => {
      const want = splitProjectPath(String(n).replace(/^#\[?|\]$/g, "")).map(key);
      if (!want.length) return false;
      if (want.length === 1) return own.includes(want[0]);
      return want.every((w, i) => own[i] === w);
    });
  };

  return { labels, hasLabel, project, inProject };
}
