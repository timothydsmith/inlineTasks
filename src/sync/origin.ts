/**
 * Which device should push a change?
 *
 * With Obsidian Sync, a line typed on the phone reaches the desktop as a file write, often several
 * times while it's still being typed. If every device pushed every change, the desktop would create
 * half-typed tasks, and both devices would create the same new line before either one's marker had
 * synced to the other.
 *
 * So a change made in this device's editor is pushed straight away, and a change that arrived some
 * other way (Obsidian Sync, OneDrive, a script writing notes) waits until the note has been quiet
 * for QUIET_MS. By then the device where it was typed has normally pushed it, and its markers have
 * synced here, so there's nothing left to create. If no device picks it up (e.g. "This device
 * creates tasks" is off on the phone, or a script wrote the note), it's pushed after the wait.
 */

/** How long a note changed from elsewhere must be quiet before this device pushes it. */
export const QUIET_MS = 120_000;
/** A file write within this long after a local edit is treated as Obsidian saving that edit. */
export const LOCAL_WINDOW_MS = 10_000;

/**
 * True if this device should hold off pushing a note for now.
 * @param lastLocalEdit when the note was last edited in this device's editor (ms), if ever
 * @param mtime when the file was last written (ms)
 */
export function holdForOtherDevice(lastLocalEdit: number | undefined, mtime: number, now: number): boolean {
  if (now - mtime >= QUIET_MS) return false; // quiet long enough: whoever changed it, push it
  const local = lastLocalEdit !== undefined && lastLocalEdit >= mtime - LOCAL_WINDOW_MS;
  return !local;
}
