import type { TaskFields } from "../parse/taskLine";

export interface TaskRecord {
  path: string;
  /** Field values at the last successful sync (three-way merge base). */
  base: TaskFields;
  /**
   * The task this line was nested under in the note when last synced (null: not nested under a
   * synced task). Undefined until first seen. Only a change here moves the task in Todoist, so
   * moving it in Todoist isn't undone by a note whose nesting hasn't changed.
   */
  parent?: string | null;
  /**
   * The order of this task's synced subtasks when last synced: as they were in the note, and as
   * they were in Todoist. Whichever side has changed since is copied to the other (the note wins
   * if both have).
   */
  kidsNote?: string[];
  kidsTodoist?: string[];
  orphaned?: boolean;
}

/** Remote-only metadata shown on the chip. */
export interface RemoteMeta {
  projectId: string;
  priority: number;
  due: string | null;
  dueString?: string;
  recurring?: boolean;
  checked: boolean;
  labels?: string[];
  /** Parent task in Todoist, or null for a top-level task. Undefined if not known yet. */
  parentId?: string | null;
  /** Its place among its siblings in Todoist (see order.ts). Undefined if not known yet. */
  orderKey?: string | null;
  childOrder?: number;
}

export interface PendingCreate {
  path: string;
  createdAt: number;
}

/**
 * What this device knows about the sync. Each device keeps its own, in local storage, because the
 * sync token, merge bases and in-flight creates are per device: sharing them through `data.json`
 * (which Obsidian Sync copies between devices) let one device overwrite another's. Only
 * `backfillDone` is shared, through `data.json`, since it records a choice made once per vault.
 */
export interface SyncState {
  syncToken: string | null;
  tasks: Record<string, TaskRecord>;
  pending: Record<string, PendingCreate>;
  remote: Record<string, RemoteMeta>;
  projects: Record<string, ProjectInfo>;
  /**
   * Projects whose `project_add` (from a `#[Name]` reference) was sent but not confirmed, keyed by
   * lower-cased name, value = command uuid. Tasks naming them wait for the next pull, which either
   * brings the project in or proves it was never created; the pull then clears this map.
   */
  pendingProjects: Record<string, string>;
  /** The user's personal Todoist labels, by id. */
  labels: Record<string, LabelInfo>;
  /** True once a full sync has filled in `labels` (state saved before labels were tracked lacks them). */
  labelsSynced?: boolean;
  /**
   * Every open subtask in Todoist, linked to a note or not: subtask id → parent id. For the
   * subtask count on the chip. Kept up to date by pulls.
   */
  subtasks: Record<string, string>;
  /** True once a full sync has filled in `subtasks` (state saved before they were tracked lacks them). */
  subtasksSynced?: boolean;
  /** True once the user has confirmed the initial backfill of existing checkboxes. */
  backfillDone: boolean;
}

export interface ProjectInfo {
  name: string;
  color?: string;
  inbox?: boolean;
  archived?: boolean;
  parentId?: string | null;
  /** Place among its sibling projects in Todoist. Missing in state saved before it was tracked. */
  order?: number;
}

export interface LabelInfo {
  name: string;
  order?: number;
}

export function emptyState(): SyncState {
  return { syncToken: null, tasks: {}, pending: {}, remote: {}, projects: {}, pendingProjects: {}, labels: {}, subtasks: {}, backfillDone: false };
}

/** How many open subtasks a task has in Todoist (direct ones, not theirs). */
export function subtaskCount(state: SyncState, id: string): number {
  let n = 0;
  for (const parent of Object.values(state.subtasks ?? {})) if (parent === id) n++;
  return n;
}
