import type { TaskFields } from "../parse/taskLine";

export type Field = keyof TaskFields;
const FIELDS: Field[] = ["text", "checked", "due", "priority"];

export interface MergeResult {
  /** Fields whose local value should be pushed to Todoist. */
  push: Partial<TaskFields>;
  /** Fields whose remote value should be written into the note. */
  pull: Partial<TaskFields>;
  /** The agreed state after the merge; becomes the new base snapshot. */
  merged: TaskFields;
  conflicts: Field[];
}

/**
 * Three-way merge of a task's fields.
 *
 * base   = state at last successful sync
 * local  = state in the note now
 * remote = state in Todoist now
 *
 * Conflict rule (both sides changed the same field to different values): the side
 * edited most recently wins. `checked` is boolean, so if both sides changed it they agree.
 */
export function merge(
  base: TaskFields,
  local: TaskFields,
  remote: TaskFields,
  localModifiedAt: number,
  remoteModifiedAt: number,
): MergeResult {
  const push: Partial<TaskFields> = {};
  const pull: Partial<TaskFields> = {};
  const merged: TaskFields = { ...base };
  const conflicts: Field[] = [];

  for (const f of FIELDS) {
    // Priority is merged only when both sides give it (the Tasks fields setting is on). A base from
    // before then has none: the line had no Tasks priority to sync, which is p4.
    if (f === "priority" && (local.priority === undefined || remote.priority === undefined)) continue;
    const l = local[f];
    const r = remote[f];
    const b = f === "priority" ? (base.priority ?? 4) : base[f];
    const localChanged = l !== b;
    const remoteChanged = r !== b;

    let winner: "local" | "remote" | "none";
    if (l === r) winner = "none";
    else if (localChanged && !remoteChanged) winner = "local";
    else if (!localChanged && remoteChanged) winner = "remote";
    else {
      conflicts.push(f);
      winner = localModifiedAt > remoteModifiedAt ? "local" : "remote";
    }

    if (winner === "local") {
      setField(push, f, l);
      setField(merged, f, l);
    } else if (winner === "remote") {
      setField(pull, f, r);
      setField(merged, f, r);
    } else {
      setField(merged, f, l);
    }
  }

  return { push, pull, merged, conflicts };
}

function setField<T extends Partial<TaskFields>>(obj: T, f: Field, v: TaskFields[Field]): void {
  (obj as Record<Field, unknown>)[f] = v;
}

export function isEmpty(p: Partial<TaskFields>): boolean {
  return Object.keys(p).length === 0;
}
