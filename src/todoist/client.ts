/**
 * Minimal client for the Todoist unified API v1 Sync endpoint.
 * HTTP is injected so this works with Obsidian's `requestUrl` (desktop + mobile) and in tests.
 */

export const SYNC_URL = "https://api.todoist.com/api/v1/sync";

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}
export type HttpFn = (req: HttpRequest) => Promise<{ status: number; json: unknown }>;

export interface TodoistDue {
  date: string; // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS[Z]"
  is_recurring?: boolean;
  string?: string;
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
  labels?: string[];
  updated_at?: string;
}

export interface TodoistProject {
  id: string;
  name: string;
  color?: string;
  inbox_project?: boolean;
  is_deleted?: boolean;
  is_archived?: boolean;
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
  sync_status?: Record<string, "ok" | { error: string; error_code?: number }>;
  temp_id_mapping?: Record<string, string>;
}

export class TodoistError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class TodoistClient {
  constructor(private token: () => string, private http: HttpFn) {}

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

/** Todoist due → YYYY-MM-DD (time component dropped). */
export function dueDate(due: TodoistDue | null | undefined): string | null {
  return due?.date ? due.date.slice(0, 10) : null;
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
