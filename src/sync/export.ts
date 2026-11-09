/**
 * **Export tasks to JSON**: a snapshot of Todoist tasks in chosen projects, for reconciling them
 * with notes. Open tasks as at the export, completed tasks back to when the account was made, the
 * completions, reopenings and deletions in Todoist's activity log, and where each task is linked
 * in the vault. The file says what it covers, so a task missing from it isn't taken as done.
 *
 * Fetching is split in two: a snapshot (one sync, plus archived projects) taken before the user
 * picks projects, and the history, fetched for the projects picked.
 */
import { findTasks, isCancelledStatus, isClosedStatus } from "../parse/taskLine";
import { taskUrl, type TodoistClient } from "../todoist/client";
import type { SyncState } from "./state";

export const EXPORT_FORMAT = "inline-tasks-todoist-export";
export const EXPORT_VERSION = 1;

/** The completed-tasks endpoint takes at most 3 months at a time. */
const COMPLETED_WINDOW_DAYS = 89;
/** The activity log takes at most 365 days at a time. */
const ACTIVITY_WINDOW_DAYS = 364;
/** Where history starts if Todoist doesn't say when the account was made: the year Todoist began. */
const FALLBACK_START = "2007-01-01T00:00:00Z";
const DAY_MS = 86_400_000;
const PAGE = 200;
const ACTIVITY_PAGE = 100;
const ACTIVITY_EVENTS = ["item:completed", "item:uncompleted", "item:deleted"];

// ------------------------------------------------------------ Todoist's shapes (snake_case, as sent)

export interface ApiDue {
  date: string;
  string?: string;
  is_recurring?: boolean;
  timezone?: string | null;
  lang?: string | null;
}

export interface ApiTask {
  id: string;
  content: string;
  description?: string;
  project_id: string;
  section_id?: string | null;
  parent_id?: string | null;
  labels?: string[];
  priority?: number;
  due?: ApiDue | null;
  deadline?: { date: string } | null;
  duration?: { amount: number; unit: string } | null;
  checked?: boolean;
  is_deleted?: boolean;
  added_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  responsible_uid?: string | null;
  child_order?: number;
}

export interface ApiProject {
  id: string;
  name: string;
  parent_id?: string | null;
  child_order?: number;
  inbox_project?: boolean;
  is_archived?: boolean;
  is_deleted?: boolean;
}

export interface ApiEvent {
  object_type: string;
  object_id: string;
  event_type: string;
  event_date: string;
  parent_project_id?: string | null;
  parent_item_id?: string | null;
  initiator_id?: string | null;
  extra_data?: { content?: string; [k: string]: unknown } | null;
}

interface ApiUser {
  id?: string;
  joined_at?: string;
  tz_info?: { timezone?: string; gmt_string?: string };
}

interface ApiPlanLimits {
  activity_log?: boolean;
  activity_log_limit?: number;
  completed_tasks?: boolean;
}

// ------------------------------------------------------------ fetching

export interface ExportProject {
  id: string;
  name: string;
  parentId: string | null;
  archived: boolean;
  inbox: boolean;
  order: number;
}

/** What's fetched before the user picks projects. */
export interface Snapshot {
  fetchedAt: Date;
  timezone: string | null;
  utcOffset: string | null;
  joinedAt: string | null;
  plan: ApiPlanLimits | null;
  projects: ExportProject[];
  sections: Record<string, string>;
  /** Open tasks in active projects. */
  open: ApiTask[];
  problems: string[];
}

/** What's fetched for the projects picked. */
export interface History {
  /** Open tasks in the archived projects picked. */
  archivedOpen: ApiTask[];
  completed: ApiTask[];
  completedFrom: string;
  completedTo: string;
  events: ApiEvent[];
  /** Null when the activity log wasn't read. */
  activityFrom: string | null;
  activityTo: string | null;
  activitySkipped: string | null;
  problems: string[];
}

interface Paged<T> {
  results?: T[];
  items?: T[];
  next_cursor?: string | null;
}

/** One full sync for projects, sections, open tasks and the user's timezone, then the archived projects. */
export async function fetchSnapshot(client: TodoistClient, now = new Date()): Promise<Snapshot> {
  const res = (await client.sync({ resourceTypes: ["items", "projects", "sections", "user", "user_plan_limits"] })) as unknown as {
    items?: ApiTask[];
    projects?: ApiProject[];
    sections?: { id: string; name: string; is_deleted?: boolean }[];
    user?: ApiUser;
    user_plan_limits?: { current?: ApiPlanLimits };
  };
  const problems: string[] = [];
  const projects = new Map<string, ExportProject>();
  const add = (p: ApiProject, archived: boolean) => {
    if (p.is_deleted) return;
    projects.set(p.id, {
      id: p.id,
      name: p.name,
      parentId: p.parent_id ?? null,
      archived: archived || !!p.is_archived,
      inbox: !!p.inbox_project,
      order: p.child_order ?? Number.MAX_SAFE_INTEGER,
    });
  };
  for (const p of res.projects ?? []) add(p, false);
  try {
    for (const p of await allPages<ApiProject>(client, "projects/archived", {})) add(p, true);
  } catch (e) {
    problems.push(`Couldn't list archived projects, so none could be picked: ${(e as Error).message}`);
  }
  const sections: Record<string, string> = {};
  for (const s of res.sections ?? []) if (!s.is_deleted) sections[s.id] = s.name;
  return {
    fetchedAt: now,
    timezone: res.user?.tz_info?.timezone ?? null,
    utcOffset: res.user?.tz_info?.gmt_string ?? null,
    joinedAt: res.user?.joined_at ?? null,
    plan: res.user_plan_limits?.current ?? null,
    projects: [...projects.values()],
    sections,
    open: (res.items ?? []).filter((t) => !t.checked && !t.is_deleted),
    problems,
  };
}

/**
 * Open tasks in the archived projects picked, completed tasks from when the account was made, and
 * the activity log as far back as the plan keeps it. A step that fails is listed in `problems`
 * and the rest carry on, so the file can say what it's missing.
 */
export async function fetchHistory(
  client: TodoistClient,
  snap: Snapshot,
  selected: Set<string>,
  progress: (msg: string) => void = () => {},
): Promise<History> {
  const problems: string[] = [];
  const now = snap.fetchedAt;
  const start = new Date(snap.joinedAt ?? FALLBACK_START);
  if (!snap.joinedAt) problems.push(`Todoist didn't say when the account was made, so completed tasks were fetched from ${FALLBACK_START.slice(0, 10)}.`);

  const archivedOpen: ApiTask[] = [];
  for (const p of snap.projects) {
    if (!p.archived || !selected.has(p.id)) continue;
    progress(`open tasks in archived project ${p.name}`);
    try {
      archivedOpen.push(...(await allPages<ApiTask>(client, "tasks", { project_id: p.id })).filter((t) => !t.checked && !t.is_deleted));
    } catch (e) {
      problems.push(`Couldn't list open tasks in archived project "${p.name}" (${p.id}): ${(e as Error).message}`);
    }
  }

  const completed = new Map<string, ApiTask>();
  for (let until = now; until > start; ) {
    const since = new Date(Math.max(start.getTime(), until.getTime() - COMPLETED_WINDOW_DAYS * DAY_MS));
    progress(`completed tasks back to ${isoDate(since)}`);
    try {
      const items = await allPages<ApiTask>(client, "tasks/completed/by_completion_date", { since: isoSeconds(since), until: isoSeconds(until) });
      for (const t of items) if (!completed.has(t.id)) completed.set(t.id, t);
    } catch (e) {
      problems.push(`Couldn't fetch tasks completed ${isoSeconds(since)} to ${isoSeconds(until)}: ${(e as Error).message}`);
    }
    until = since;
  }

  const plan = snap.plan;
  let activityFrom: string | null = null;
  let activityTo: string | null = null;
  let activitySkipped: string | null = null;
  const events = new Map<string, ApiEvent>();
  if (plan && plan.activity_log === false) {
    activitySkipped = "The Todoist plan doesn't include the activity log.";
  } else {
    const limit = plan?.activity_log_limit;
    const from = limit && limit > 0 ? new Date(Math.max(start.getTime(), now.getTime() - limit * DAY_MS)) : start;
    // Whole days. `date_to` is read as exclusive by some clients and inclusive by others: tomorrow covers both.
    let to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    activityTo = isoDate(to);
    activityFrom = isoDate(from);
    while (to > from) {
      const windowFrom = new Date(Math.max(from.getTime(), to.getTime() - ACTIVITY_WINDOW_DAYS * DAY_MS));
      progress(`activity back to ${isoDate(windowFrom)}`);
      try {
        const page = await allPages<ApiEvent>(
          client,
          "activities",
          { object_event_types: ACTIVITY_EVENTS, date_from: isoDate(windowFrom), date_to: isoDate(to) },
          ACTIVITY_PAGE,
        );
        for (const ev of page) {
          if (ev.object_type !== "item") continue;
          events.set(`${ev.object_id}|${ev.event_type}|${ev.event_date}`, ev);
        }
      } catch (e) {
        problems.push(`Couldn't read the activity log ${isoDate(windowFrom)} to ${isoDate(to)}: ${(e as Error).message}`);
      }
      to = windowFrom;
    }
  }

  return {
    archivedOpen,
    completed: [...completed.values()],
    completedFrom: isoSeconds(start),
    completedTo: isoSeconds(now),
    events: [...events.values()],
    activityFrom,
    activityTo,
    activitySkipped,
    problems,
  };
}

/** Every page of a cursor-paged REST list. Lists come back as `results`, completed tasks as `items`. */
async function allPages<T>(client: TodoistClient, path: string, params: Record<string, string | string[]>, limit = PAGE): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10_000; guard++) {
    const res: Paged<T> = await client.get<Paged<T>>(path, { ...params, limit, cursor });
    out.push(...(res.results ?? res.items ?? []));
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

// ------------------------------------------------------------ the vault's side

export interface ObsidianLine {
  path: string;
  /** 1-based, as editors number lines. */
  line: number;
  /** The character in the checkbox. */
  status: string;
  /** What the checkbox means: `[ ]` open, `[x]` done, `[-]` cancelled, anything else other. */
  checkbox: "open" | "done" | "cancelled" | "other";
  text: string;
  /** The line's `^block` id, without the `^`, or null. */
  blockRef: string | null;
  /** A link to the line: `[[path#^block]]`, or null when it has no block id. */
  blockLink: string | null;
  /** ⏳ (Todoist's date, as this plugin writes it). */
  doDate: string | null;
  /** ➕ */
  createdDate: string | null;
  /** 🛫 */
  startDate: string | null;
  /** 📅 (Todoist's deadline, as this plugin writes it). */
  deadline: string | null;
  /** ✅ */
  doneDate: string | null;
  /** ❌ */
  cancelledDate: string | null;
  /** 🔁 */
  recurrence: string | null;
}

/** Every checkbox line with a Todoist marker in a note, by task id. */
export function linkedLines(path: string, content: string): Map<string, ObsidianLine[]> {
  const out = new Map<string, ObsidianLine[]>();
  if (!content.includes("%%td:")) return out;
  for (const { line, task } of findTasks(content)) {
    if (!task.todoistId) continue;
    const f = task.fields ?? {};
    const block = task.blockLink ?? null;
    const entry: ObsidianLine = {
      path,
      line: line + 1,
      status: task.status,
      checkbox: task.status === " " ? "open" : isCancelledStatus(task.status) ? "cancelled" : isClosedStatus(task.status) ? "done" : "other",
      text: task.text,
      blockRef: block,
      blockLink: block ? `[[${path.replace(/\.md$/i, "")}#^${block}]]` : null,
      doDate: task.due ?? null,
      createdDate: f.created ?? null,
      startDate: f.start ?? null,
      deadline: task.deadline ?? null,
      doneDate: f.done ?? null,
      cancelledDate: f.cancelled ?? null,
      recurrence: f.recurrence ?? null,
    };
    out.set(task.todoistId, [...(out.get(task.todoistId) ?? []), entry]);
  }
  return out;
}

// ------------------------------------------------------------ the file

export interface ExportMeta {
  pluginVersion: string;
  device: string;
  vault: string;
  /** The device's own timezone, from Intl. */
  deviceTimezone: string | null;
}

export interface ExportedTask {
  id: string;
  title: string;
  state: "open" | "completed";
  /** True when Todoist reports it deleted, or the activity log has it being deleted. */
  deleted: boolean;
  deletedAt: string | null;
  projectId: string;
  projectName: string | null;
  /** Its project's parents' names and its own, outermost first. Empty when the project isn't known (deleted). */
  projectPath: string[];
  projectArchived: boolean | null;
  sectionId: string | null;
  sectionName: string | null;
  parentId: string | null;
  labels: string[];
  priority: { api: number; label: string };
  due: {
    date: string;
    time: string | null;
    timezone: string | null;
    raw: string;
    string: string | null;
    isRecurring: boolean;
    lang: string | null;
  } | null;
  deadline: string | null;
  duration: { amount: number; unit: string } | null;
  description: string;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  assigneeId: string | null;
  url: string;
  obsidian: {
    /** This device's sync state links the task to a note. */
    pluginLinked: boolean;
    pluginNotePath: string | null;
    /** Its line was deleted from the note, which unlinked it. */
    unlinked: boolean;
    /** Lines with its marker, in any note. */
    lines: ObsidianLine[];
    /** ⏳ and ➕ from its first line that has them; null when unknown. */
    doDate: string | null;
    createdDate: string | null;
  } | null;
}

export interface ExportedEvent {
  taskId: string;
  event: string;
  at: string;
  projectId: string | null;
  projectName: string | null;
  parentTaskId: string | null;
  /** The task's title at the time, as the activity log has it. */
  title: string | null;
  initiatorId: string | null;
  /** Whether the task itself is in `tasks`. */
  taskInExport: boolean;
}

export function buildExport(
  snap: Snapshot,
  hist: History,
  selected: Set<string>,
  links: Map<string, ObsidianLine[]>,
  state: Pick<SyncState, "tasks">,
  meta: ExportMeta,
) {
  const projects = new Map(snap.projects.map((p) => [p.id, p]));
  const path = (id: string): string[] => {
    const names: string[] = [];
    for (let p = projects.get(id), guard = 0; p && guard < 20; p = p.parentId ? projects.get(p.parentId) : undefined, guard++) names.unshift(p.name);
    return names;
  };

  const deletedAt = new Map<string, string>();
  for (const ev of hist.events) {
    if (ev.event_type === "deleted" && (!deletedAt.has(ev.object_id) || deletedAt.get(ev.object_id)! < ev.event_date)) deletedAt.set(ev.object_id, ev.event_date);
  }

  const task = (t: ApiTask, open: boolean): ExportedTask => {
    const project = projects.get(t.project_id);
    const rec = state.tasks[t.id];
    const lines = links.get(t.id) ?? [];
    const raw = t.due?.date ?? null;
    return {
      id: t.id,
      title: t.content,
      state: open ? "open" : "completed",
      deleted: !!t.is_deleted || deletedAt.has(t.id),
      deletedAt: deletedAt.get(t.id) ?? null,
      projectId: t.project_id,
      projectName: project?.name ?? null,
      projectPath: path(t.project_id),
      projectArchived: project ? project.archived : null,
      sectionId: t.section_id ?? null,
      sectionName: t.section_id ? (snap.sections[t.section_id] ?? null) : null,
      parentId: t.parent_id ?? null,
      labels: t.labels ?? [],
      priority: { api: t.priority ?? 1, label: `p${5 - (t.priority ?? 1)}` },
      due: t.due && raw
        ? {
            date: raw.slice(0, 10),
            time: raw.length > 10 ? raw.slice(11, 19) : null,
            timezone: t.due.timezone ?? (raw.endsWith("Z") ? "UTC" : null),
            raw,
            string: t.due.string ?? null,
            isRecurring: !!t.due.is_recurring,
            lang: t.due.lang ?? null,
          }
        : null,
      deadline: t.deadline?.date ?? null,
      duration: t.duration ?? null,
      description: t.description ?? "",
      createdAt: t.added_at ?? null,
      updatedAt: t.updated_at ?? null,
      completedAt: open ? null : (t.completed_at ?? null),
      assigneeId: t.responsible_uid ?? null,
      url: taskUrl(t.id),
      obsidian:
        rec || lines.length
          ? {
              pluginLinked: !!rec,
              pluginNotePath: rec?.path ?? null,
              unlinked: !!rec?.orphaned,
              lines,
              doDate: lines.find((l) => l.doDate)?.doDate ?? null,
              createdDate: lines.find((l) => l.createdDate)?.createdDate ?? null,
            }
          : null,
    };
  };

  const openIds = new Set<string>();
  const tasks: ExportedTask[] = [];
  for (const t of [...snap.open, ...hist.archivedOpen]) {
    if (!selected.has(t.project_id) || openIds.has(t.id)) continue;
    openIds.add(t.id);
    tasks.push(task(t, true));
  }
  let completedOutside = 0;
  let completedUnknownProject = 0;
  for (const t of hist.completed) {
    if (openIds.has(t.id)) continue; // reopened since: the open copy is current
    if (!selected.has(t.project_id)) {
      if (projects.has(t.project_id)) completedOutside++;
      else completedUnknownProject++;
      continue;
    }
    tasks.push(task(t, false));
  }
  const order = new Map(projectTreeOrder(snap.projects).map((p, i) => [p.id, i]));
  tasks.sort(
    (a, b) =>
      (a.state === b.state ? 0 : a.state === "open" ? -1 : 1) ||
      (a.state === "completed" ? (b.completedAt ?? "").localeCompare(a.completedAt ?? "") : 0) ||
      (order.get(a.projectId) ?? Infinity) - (order.get(b.projectId) ?? Infinity) ||
      (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
  );

  const exportedIds = new Set(tasks.map((t) => t.id));
  const events: ExportedEvent[] = hist.events
    .filter((ev) => (ev.parent_project_id && selected.has(ev.parent_project_id)) || exportedIds.has(ev.object_id))
    .sort((a, b) => b.event_date.localeCompare(a.event_date))
    .map((ev) => ({
      taskId: ev.object_id,
      event: ev.event_type,
      at: ev.event_date,
      projectId: ev.parent_project_id ?? null,
      projectName: ev.parent_project_id ? (projects.get(ev.parent_project_id)?.name ?? null) : null,
      parentTaskId: ev.parent_item_id ?? null,
      title: typeof ev.extra_data?.content === "string" ? ev.extra_data.content : null,
      initiatorId: ev.initiator_id ?? null,
      taskInExport: exportedIds.has(ev.object_id),
    }));

  const picked = projectTreeOrder(snap.projects).filter((p) => selected.has(p.id));
  const problems = [...snap.problems, ...hist.problems];
  const tz = snap.timezone;
  const counts = {
    open: tasks.filter((t) => t.state === "open").length,
    completed: tasks.filter((t) => t.state === "completed").length,
    linkedToNotes: tasks.filter((t) => t.obsidian?.lines.length).length,
    events: events.length,
  };

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: snap.fetchedAt.toISOString(),
    exportedAtLocal: tz ? localIso(snap.fetchedAt, tz) : null,
    timezone: { todoist: tz, todoistUtcOffset: snap.utcOffset, device: meta.deviceTimezone, timestamps: "Todoist's timestamps (createdAt, updatedAt, completedAt, events' at) are UTC. Due dates without a timezone are floating: read them in the Todoist timezone." },
    generator: { plugin: "Inline Tasks for Todoist", version: meta.pluginVersion, device: meta.device, vault: meta.vault },
    coverage: {
      complete: problems.length === 0,
      problems,
      projects: picked.map((p) => ({ id: p.id, name: p.name, path: path(p.id), archived: p.archived, inbox: p.inbox })),
      openTasks: {
        asOf: snap.fetchedAt.toISOString(),
        description:
          "Every open task in the projects listed, as at exportedAt: subtasks, undated, overdue and recurring tasks included. Open tasks in archived projects are fetched separately; see problems for any that failed.",
      },
      completedTasks: {
        from: hist.completedFrom,
        to: hist.completedTo,
        description:
          "Tasks completed in the projects listed between these times (from when the Todoist account was made), as Todoist's completed-tasks archive has them. A task is listed under its project at completion.",
        planIncludesCompletedArchive: snap.plan?.completed_tasks ?? null,
        completedInOtherProjects: completedOutside,
        completedInDeletedProjects: completedUnknownProject,
      },
      activity: {
        from: hist.activityFrom,
        to: hist.activityTo,
        skipped: hist.activitySkipped,
        planHistoryDays: snap.plan?.activity_log_limit ?? null,
        eventTypes: ["completed", "uncompleted", "deleted"],
        description:
          "Completions, reopenings and deletions from Todoist's activity log, for tasks in the projects listed (by the task's project at the time) and for any task in tasks. Each completion of a recurring task is a 'completed' event.",
      },
      caveats: [
        "A task missing from this file is not evidence that it was completed. It may be in a project not listed, deleted, moved, or outside the history covered above.",
        "Recurring tasks stay open when completed: each completion appears only in events.",
        "Todoist has no cancelled state. A checkbox cancelled in Obsidian ([-]) completes its Todoist task; obsidian.lines[].checkbox shows 'cancelled'.",
        "Deleted tasks can't be fetched from Todoist. They appear only in events, as 'deleted', with their title at the time, within the activity history covered above.",
        "Obsidian links are read from the vault at export time on this device: obsidian.lines are lines with the task's %%td:<id>%% marker, and pluginLinked is this device's sync state. ⏳ and ➕ dates are from those lines and are null when unknown.",
      ],
    },
    counts,
    tasks,
    events,
  };
}

export type TodoistExport = ReturnType<typeof buildExport>;

// ------------------------------------------------------------ project tree for the picker

export interface ExportProjectNode extends ExportProject {
  depth: number;
}

/**
 * Every project, active and archived, nested as in Todoist's sidebar: the Inbox first, then each
 * project in Todoist's order with its subprojects beneath it, archived ones after active siblings.
 * A project whose parent isn't known is listed at the top level.
 */
export function projectTreeOrder(projects: ExportProject[]): ExportProjectNode[] {
  const ids = new Set(projects.map((p) => p.id));
  const kids = new Map<string | null, ExportProject[]>();
  for (const p of projects) {
    const parent = p.parentId && ids.has(p.parentId) ? p.parentId : null;
    kids.set(parent, [...(kids.get(parent) ?? []), p]);
  }
  const rank = (p: ExportProject) => (p.inbox ? 0 : p.archived ? 2 : 1);
  for (const list of kids.values()) list.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.name.localeCompare(b.name));
  const out: ExportProjectNode[] = [];
  const seen = new Set<string>();
  const visit = (p: ExportProject, depth: number) => {
    if (seen.has(p.id)) return;
    seen.add(p.id);
    out.push({ ...p, depth });
    for (const k of kids.get(p.id) ?? []) visit(k, depth + 1);
  };
  for (const p of kids.get(null) ?? []) visit(p, 0);
  return out;
}

/** A project and all its subprojects' ids. */
export function withDescendants(projects: ExportProject[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const p of projects) if (p.parentId === out[i] && !out.includes(p.id)) out.push(p.id);
  return out;
}

// ------------------------------------------------------------ dates

function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `d` as a local time in `tz` with its UTC offset, e.g. 2026-11-09T13:10:00+11:00. UTC if `tz` isn't known. */
export function localIso(d: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    const wall = Date.UTC(+get("year"), +get("month") - 1, +get("day"), +get("hour"), +get("minute"), +get("second"));
    const offset = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
    const abs = Math.abs(offset);
    const sign = offset < 0 ? "-" : "+";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  } catch {
    return isoSeconds(d);
  }
}

/** A file name for the export, from the time in `tz`: `Todoist export 2026-11-09 1310.json`. */
export function exportFileName(d: Date, tz: string | null): string {
  const local = tz ? localIso(d, tz) : isoSeconds(d);
  return `Todoist export ${local.slice(0, 10)} ${local.slice(11, 13)}${local.slice(14, 16)}.json`;
}
