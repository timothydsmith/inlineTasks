import type { TaskFields } from "../parse/taskLine";

export interface TaskRecord {
  path: string;
  /** Field values at the last successful sync (three-way merge base). */
  base: TaskFields;
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
  /** True once the user has confirmed the initial backfill of existing checkboxes. */
  backfillDone: boolean;
}

export interface ProjectInfo {
  name: string;
  color?: string;
  inbox?: boolean;
  archived?: boolean;
  parentId?: string | null;
}

export function emptyState(): SyncState {
  return { syncToken: null, tasks: {}, pending: {}, remote: {}, projects: {}, pendingProjects: {}, backfillDone: false };
}
