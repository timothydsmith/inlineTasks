/**
 * Which device should push a change?
 *
 * With Obsidian Sync, a line typed on the phone reaches the desktop as a file write, often several
 * times while it's still being typed. If every device pushed every change, the desktop would create
 * half-typed tasks, and both devices would create the same new line before either one's marker had
 * synced to the other.
 *
 * So each change to a note is classified when it happens:
 * - **local**: made in this device's editor, or written by another plugin (Tasks' query results or
 *   edit dialog, a checkbox ticked in reading view) right after a click or key press in this window.
 *   Pushed straight away.
 * - **own**: the plugin's own write (a marker, a pulled change). Doesn't change the note's origin.
 * - **elsewhere**: anything else (Obsidian Sync, OneDrive, a script). The note is held until it has
 *   been quiet for QUIET_MS, by which time the device where it was typed has normally pushed it and
 *   its markers have synced here. After that it's pushed, but only a device set to create tasks for
 *   changes from elsewhere (by default: desktop, not mobile) creates new tasks from it, so a note
 *   written by a script isn't created once per device.
 */

/** How long a note changed from elsewhere must be quiet before this device pushes it. */
export const QUIET_MS = 120_000;
/** A file write this soon after a local edit is Obsidian saving that edit (autosave is ~2s). */
export const LOCAL_WINDOW_MS = 5_000;
/** An editor change this soon after a key press or tap in Obsidian counts as caused by it. */
export const INPUT_WINDOW_MS = 1_500;
/** A file write this soon after a click or key press in this window was caused by it, e.g. Tasks writing a ticked query result. */
export const WRITE_AFTER_INPUT_MS = 3_000;

export type ChangeOrigin = "local" | "own" | "elsewhere";

export interface PushStatus {
  /** Wait: the note changed elsewhere less than QUIET_MS ago, and hasn't been edited here since. */
  hold: boolean;
  /** The note's latest change came from elsewhere (and hasn't been edited here since). */
  fromElsewhere: boolean;
}

export class OriginTracker {
  private local = new Map<string, number>();
  private elsewhere = new Map<string, number>();
  private ownContent = new Map<string, string>();

  /** The note was edited in this device's editor. */
  localEdit(path: string, now: number): void {
    this.local.set(path, now);
  }

  /** The plugin is about to write, or has just written, `content` to the note. */
  ownWrite(path: string, content: string): void {
    this.ownContent.set(path, content);
  }

  /**
   * Classify a write to the note, given its new content. Call on every modify event, with the time
   * of the last click or key press in this window while it had focus.
   */
  modified(path: string, content: string, now: number, lastInputAt = -Infinity): ChangeOrigin {
    if (this.ownContent.get(path) === content) return "own";
    this.ownContent.delete(path);
    if (now - lastInputAt < WRITE_AFTER_INPUT_MS) this.local.set(path, now);
    const local = this.local.get(path);
    if (local !== undefined && now - local <= LOCAL_WINDOW_MS) return "local";
    this.elsewhere.set(path, now);
    return "elsewhere";
  }

  status(path: string, now: number): PushStatus {
    const ext = this.elsewhere.get(path);
    if (ext === undefined) return { hold: false, fromElsewhere: false };
    const local = this.local.get(path);
    if (local !== undefined && local > ext) return { hold: false, fromElsewhere: false }; // edited here since
    return { hold: now - ext < QUIET_MS, fromElsewhere: true };
  }

  rename(oldPath: string, newPath: string): void {
    for (const m of [this.local, this.elsewhere, this.ownContent] as Map<string, unknown>[]) {
      if (m.has(oldPath)) {
        m.set(newPath, m.get(oldPath));
        m.delete(oldPath);
      }
    }
  }
}

/**
 * userEvents that aren't the user's input. Obsidian applies a change on disk (Obsidian Sync,
 * another app) to an open editor as a transaction with userEvent "set".
 */
const NOT_INPUT = new Set(["set"]);

/**
 * Was this editor change made on this device?
 *
 * Focus alone isn't enough: a desktop window can sit focused on a note while you type on your
 * phone, and Obsidian Sync then rewrites that focused editor. So a change counts as local only if
 * CodeMirror marks it as user input (typing, paste, delete, undo, ...), or if it closely follows a
 * real key press or tap while the editor has focus, which covers ticking a checkbox and commands.
 */
export function isLocalChange(
  userEvents: (string | undefined)[],
  lastInputAt: number,
  editorHasFocus: boolean,
  now: number,
): boolean {
  if (userEvents.some((ev) => !!ev && !ev.startsWith("select") && !NOT_INPUT.has(ev))) return true;
  return editorHasFocus && now - lastInputAt < INPUT_WINDOW_MS;
}
