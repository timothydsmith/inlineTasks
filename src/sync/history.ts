/**
 * History lines for a repeating task completed in Todoist.
 *
 * Ticking a repeating task with the Tasks plugin leaves the ticked line as a record and adds a line
 * for the next occurrence. Completing one in Todoist only moves its date, so without these the note
 * would keep no record of it. Each completion in Todoist's activity log, of an occurrence between
 * the line's old date and its new one, gets a ticked line like the one Tasks leaves: the line as it
 * was, without the marker or block link, with that occurrence's date and a `✅` date of when it
 * was completed.
 */
import { serializeTask, withDoneDate, type ParsedTask } from "../parse/taskLine";
import { isoDate } from "./dates";

/** A completion in Todoist's activity log, as far as it's used here. */
export interface CompletionEvent {
  object_id: string;
  event_type: string;
  event_date: string;
  extra_data?: Record<string, unknown> | null;
}

/** A value in an event's extra data, matching the key whatever its case or underscores. */
function extra(ev: CompletionEvent, key: string): unknown {
  const want = key.toLowerCase();
  for (const [k, v] of Object.entries(ev.extra_data ?? {})) if (k.replace(/_/g, "").toLowerCase() === want) return v;
  return undefined;
}

/** The date of the occurrence a completion was of, YYYY-MM-DD, or null if the event doesn't say. */
export function occurrenceDate(ev: CompletionEvent): string | null {
  const local = extra(ev, "completedDueDateLocal");
  if (typeof local === "string" && /^\d{4}-\d{2}-\d{2}/.test(local)) return local.slice(0, 10);
  const utc = extra(ev, "completedDueDate");
  if (typeof utc === "string") {
    const d = new Date(utc);
    if (!Number.isNaN(d.getTime())) return isoDate(d);
  }
  return null;
}

/**
 * The ticked lines to leave for a task's completions in Todoist of occurrences from `from` up to
 * (not including) `to`, newest first. `line` is the task's line as it was before the pull moved it.
 * An occurrence completed more than once (completed, reopened, completed again) gets one line,
 * dated by its latest completion.
 */
export function historyLines(line: ParsedTask, id: string, events: readonly CompletionEvent[], from: string, to: string): string[] {
  const done = new Map<string, string>();
  const latest = new Map<string, string>();
  for (const ev of events) {
    if (ev.object_id !== id || ev.event_type !== "completed") continue;
    const occ = occurrenceDate(ev);
    if (!occ || occ < from || occ >= to) continue;
    const at = Date.parse(ev.event_date);
    if (Number.isNaN(at)) continue;
    if ((latest.get(occ) ?? "") >= ev.event_date) continue;
    latest.set(occ, ev.event_date);
    done.set(occ, isoDate(new Date(at)));
  }
  return [...done.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([occ, date]) =>
      serializeTask({
        ...line,
        todoistId: null,
        pendingUuid: null,
        projectRef: null,
        labelRefs: [],
        priorityRef: null,
        dueRef: null,
        // Links to the block go to the open line, so its id stays there alone.
        blockLink: null,
        status: "x",
        checked: true,
        due: occ,
        fields: withDoneDate(line.fields, date),
      }),
    );
}
