/**
 * Minimal client for the Todoist unified API v1 Sync endpoint.
 * HTTP is injected so this works with Obsidian's `requestUrl` (desktop + mobile) and in tests.
 */

export const SYNC_URL = "https://api.todoist.com/api/v1/sync";
export const REST_URL = "https://api.todoist.com/api/v1/";

export interface HttpRequest {
  url: string;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
}

/** A query parameter for a REST GET: arrays are sent as JSON, as Todoist expects. Null and undefined are left out. */
export type QueryValue = string | number | boolean | string[] | null | undefined;

/** How many times a rate-limited GET is retried, after the wait Todoist asks for. */
const RATE_LIMIT_RETRIES = 3;
export type HttpFn = (req: HttpRequest) => Promise<{ status: number; json: unknown }>;

export interface TodoistDue {
  /** "YYYY-MM-DD"; with a time, "YYYY-MM-DDTHH:MM:SS" (floating), or in UTC ending "Z" for a fixed timezone. */
  date: string;
  is_recurring?: boolean;
  string?: string;
  /** The timezone of a time fixed to one, null for a floating time or a date. */
  timezone?: string | null;
}

export interface TodoistItem {
  id: string;
  content: string;
  description: string;
  project_id: string;
  checked: boolean;
  is_deleted: boolean;
  priority: number; // 1 (normal) .. 4 (urgent)
  due: TodoistDue | null;
  /** The deadline: when it must be done, a date without a time. */
  deadline?: { date: string; lang?: string } | null;
  labels?: string[];
  /** The parent task's id, for a subtask. */
  parent_id?: string | null;
  /** Position among its siblings (older ordering; see order_key). */
  child_order?: number;
  /** Fractional-indexing key: siblings sort by comparing these. Null for tasks not migrated yet. */
  order_key?: string | null;
  updated_at?: string;
  /** When it was added. */
  added_at?: string;
  /** When it was completed, for a completed task. */
  completed_at?: string | null;
}

export interface TodoistProject {
  id: string;
  name: string;
  color?: string;
  inbox_project?: boolean;
  is_deleted?: boolean;
  is_archived?: boolean;
  parent_id?: string | null;
  /** Place among its sibling projects. */
  child_order?: number;
}

export interface TodoistLabel {
  id: string;
  name: string;
  item_order?: number;
  is_deleted?: boolean;
}

export interface Command {
  type: string;
  uuid: string;
  temp_id?: string;
  args: Record<string, unknown>;
}

export interface SyncResponse {
  sync_token: string;
  full_sync: boolean;
  items?: TodoistItem[];
  projects?: TodoistProject[];
  labels?: TodoistLabel[];
  sync_status?: Record<string, "ok" | { error: string; error_code?: number; error_extra?: Record<string, unknown> }>;
  temp_id_mapping?: Record<string, string>;
}

export class TodoistError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class TodoistClient {
  constructor(
    private token: () => string,
    private http: HttpFn,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * GET a REST endpoint under /api/v1/ (`tasks/completed/by_completion_date`, ...). Retries a
   * 429 after the `retry_after` Todoist sends. The error says what Todoist said, for the export's
   * list of problems.
   */
  async get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<T> {
    const token = this.token();
    if (!token) throw new TodoistError("No Todoist API token configured");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      qs.set(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
    }
    const query = qs.toString();
    const url = `${REST_URL}${path}${query ? `?${query}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.http({ url, method: "GET", headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const after = Number((res.json as { error_extra?: { retry_after?: number } } | null)?.error_extra?.retry_after);
        await this.sleep((Number.isFinite(after) && after > 0 ? after : 5) * 1000);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new TodoistError("Todoist rejected the API token", res.status);
      if (res.status >= 400) {
        const body = res.json as { error?: string } | null;
        throw new TodoistError(`Todoist ${path} failed (${res.status}${body?.error ? `: ${body.error}` : ""})`, res.status);
      }
      return res.json as T;
    }
  }

  async sync(params: {
    syncToken?: string;
    resourceTypes?: string[];
    commands?: Command[];
  }): Promise<SyncResponse> {
    const token = this.token();
    if (!token) throw new TodoistError("No Todoist API token configured");

    const form = new URLSearchParams();
    if (params.resourceTypes) {
      form.set("sync_token", params.syncToken ?? "*");
      form.set("resource_types", JSON.stringify(params.resourceTypes));
    }
    if (params.commands?.length) form.set("commands", JSON.stringify(params.commands));

    const res = await this.http({
      url: SYNC_URL,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (res.status === 401 || res.status === 403) throw new TodoistError("Todoist rejected the API token", res.status);
    if (res.status >= 400) throw new TodoistError(`Todoist sync failed (${res.status})`, res.status);
    return res.json as SyncResponse;
  }
}

export function taskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${id}`;
}

/** Todoist due → YYYY-MM-DD, the day it falls on where it's set (see dueParts). */
export function dueDate(due: TodoistDue | null | undefined): string | null {
  return dueParts(due)?.date ?? null;
}

/**
 * A Todoist due's day (`YYYY-MM-DD`) and time of day (`HH:MM:SS`, null for a date alone). A
 * floating time is as written; one fixed to a timezone, which Todoist gives in UTC, is in that
 * timezone, so a 9am task in Melbourne is on its own day, not the UTC one before.
 */
export function dueParts(due: TodoistDue | null | undefined): { date: string; time: string | null; timezone: string | null } | null {
  if (!due?.date) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z)?)?$/.exec(due.date);
  if (!m) return { date: due.date.slice(0, 10), time: null, timezone: null };
  const [, date, hm, ss, utc] = m;
  if (!hm) return { date, time: null, timezone: null };
  if (!utc) return { date, time: `${hm}:${ss ?? "00"}`, timezone: null };
  const timezone = due.timezone || "UTC";
  const local = wallTime(new Date(due.date), timezone);
  return local ? { ...local, timezone } : { date, time: `${hm}:${ss ?? "00"}`, timezone: "UTC" };
}

/** The day and time of day an instant is in a timezone, or null if the timezone isn't known. */
function wallTime(at: Date, timeZone: string): { date: string; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
    return { date: `${p("year")}-${p("month")}-${p("day")}`, time: `${p("hour")}:${p("minute")}:${p("second")}` };
  } catch {
    return null;
  }
}

/**
 * The `date` (and `timezone`) of a Todoist due on `date` at a time of day kept from before: floating
 * as `YYYY-MM-DDTHH:MM:SS`, or for a time fixed to a timezone, that time there, in UTC. A date alone
 * without a time.
 */
export function dueAt(date: string, time?: string | null, timezone?: string | null): { date: string; timezone?: string } {
  if (!time) return { date };
  if (!timezone) return { date: `${date}T${time}` };
  // The UTC instant whose wall time in the timezone is date and time: guess, then correct by the
  // offset there, twice, for a guess on the other side of a daylight-saving change.
  const target = Date.parse(`${date}T${time}Z`);
  let at = target;
  for (let i = 0; i < 2; i++) {
    const wall = wallTime(new Date(at), timezone);
    if (!wall) return { date: `${date}T${time}` };
    at += target - Date.parse(`${wall.date}T${wall.time}Z`);
  }
  return { date: new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z"), timezone };
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
