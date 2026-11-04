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

export interface SyncState {
  syncToken: string | null;
  tasks: Record<string, TaskRecord>;
  pending: Record<string, PendingCreate>;
  remote: Record<string, RemoteMeta>;
  projects: Record<string, { name: string; color?: string; inbox?: boolean }>;
  /** True once the user has confirmed the initial backfill of existing checkboxes. */
  backfillDone: boolean;
}

export function emptyState(): SyncState {
  return { syncToken: null, tasks: {}, pending: {}, remote: {}, projects: {}, backfillDone: false };
}
