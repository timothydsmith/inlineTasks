import { describe, expect, it } from "vitest";
import {
  buildExport,
  exportFileName,
  fetchHistory,
  fetchSnapshot,
  linkedLines,
  localIso,
  projectTreeOrder,
  withDescendants,
  type ApiTask,
  type ExportProject,
  type History,
  type Snapshot,
} from "../src/sync/export";
import { emptyState } from "../src/sync/state";
import { TodoistClient, type HttpRequest } from "../src/todoist/client";

/** A client whose GETs are answered by `route(path, params)`, and whose sync returns `sync`. */
function fakeClient(route: (path: string, q: URLSearchParams) => { status?: number; json: unknown }, sync: unknown = {}) {
  const calls: HttpRequest[] = [];
  const client = new TodoistClient(
    () => "tok",
    async (req) => {
      calls.push(req);
      if (req.method === "POST") return { status: 200, json: sync };
      const url = new URL(req.url);
      const r = route(url.pathname.replace("/api/v1/", ""), url.searchParams);
      return { status: r.status ?? 200, json: r.json };
    },
    async () => {},
  );
  return { client, calls };
}

const project = (id: string, name: string, extra: Partial<ExportProject> = {}): ExportProject => ({ id, name, parentId: null, archived: false, inbox: false, order: 0, ...extra });

function snapshot(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: new Date("2026-11-09T02:10:00Z"),
    timezone: "Australia/Sydney",
    utcOffset: "+11:00",
    joinedAt: "2026-01-01T00:00:00Z",
    plan: { activity_log: true, activity_log_limit: -1, completed_tasks: true },
    projects: [project("in", "Inbox", { inbox: true }), project("w", "Work", { order: 1 }), project("c", "Clients", { parentId: "w" }), project("h", "Home", { order: 2 }), project("old", "Old work", { archived: true, parentId: "w" })],
    sections: { s1: "Next" },
    open: [],
    problems: [],
    ...extra,
  };
}

function history(extra: Partial<History> = {}): History {
  return {
    archivedOpen: [],
    completed: [],
    completedFrom: "2026-01-01T00:00:00Z",
    completedTo: "2026-11-09T02:10:00Z",
    events: [],
    activityFrom: "2026-01-01",
    activityTo: "2026-11-10",
    activitySkipped: null,
    problems: [],
    ...extra,
  };
}

const meta = { pluginVersion: "0.3.0", device: "desktop", vault: "Vault", deviceTimezone: "Australia/Sydney" };
const task = (id: string, project_id: string, extra: Partial<ApiTask> = {}): ApiTask => ({ id, content: `Task ${id}`, project_id, ...extra });

describe("TodoistClient.get", () => {
  it("sends arrays as JSON, leaves out empty values, and retries after a 429", async () => {
    let n = 0;
    const { client, calls } = fakeClient(() => (n++ === 0 ? { status: 429, json: { error_extra: { retry_after: 1 } } } : { json: { results: [] } }));
    await client.get("activities", { object_event_types: ["item:completed"], cursor: null, limit: 100 });
    expect(calls).toHaveLength(2);
    const url = new URL(calls[1].url);
    expect(url.pathname).toBe("/api/v1/activities");
    expect(url.searchParams.get("object_event_types")).toBe('["item:completed"]');
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(calls[1].headers.Authorization).toBe("Bearer tok");
  });

  it("says what Todoist said when a request fails", async () => {
    const { client } = fakeClient(() => ({ status: 400, json: { error: "date range cannot exceed 365 days" } }));
    await expect(client.get("activities")).rejects.toThrow("date range cannot exceed 365 days");
  });
});

describe("fetchSnapshot", () => {
  it("adds archived projects to the synced ones, and keeps only open tasks", async () => {
    const sync = {
      items: [task("a", "w"), task("b", "w", { checked: true }), task("d", "w", { is_deleted: true })],
      projects: [{ id: "w", name: "Work", child_order: 1 }],
      sections: [{ id: "s1", name: "Next" }],
      user: { joined_at: "2020-03-01T00:00:00Z", tz_info: { timezone: "Australia/Sydney", gmt_string: "+11:00" } },
      user_plan_limits: { current: { activity_log_limit: -1 } },
    };
    const { client } = fakeClient((path, q) => {
      expect(path).toBe("projects/archived");
      return q.get("cursor") ? { json: { results: [{ id: "o2", name: "Older" }], next_cursor: null } } : { json: { results: [{ id: "o1", name: "Old", parent_id: "w" }], next_cursor: "p2" } };
    }, sync);
    const snap = await fetchSnapshot(client);
    expect(snap.projects.map((p) => [p.id, p.archived])).toEqual([["w", false], ["o1", true], ["o2", true]]);
    expect(snap.open.map((t) => t.id)).toEqual(["a"]);
    expect(snap.timezone).toBe("Australia/Sydney");
    expect(snap.joinedAt).toBe("2020-03-01T00:00:00Z");
    expect(snap.sections).toEqual({ s1: "Next" });
  });
});

describe("fetchHistory", () => {
  it("walks completed tasks back to the account's start in windows under 3 months, and the activity log a year at a time", async () => {
    const completedWindows: [string, string][] = [];
    const activityWindows: [string, string][] = [];
    const { client } = fakeClient((path, q) => {
      if (path === "tasks/completed/by_completion_date") {
        completedWindows.push([q.get("since")!, q.get("until")!]);
        return { json: { items: [task("c1", "w", { completed_at: "2026-06-01T00:00:00Z" })], next_cursor: null } };
      }
      if (path === "activities") {
        activityWindows.push([q.get("date_from")!, q.get("date_to")!]);
        return { json: { results: [{ object_type: "item", object_id: "c1", event_type: "completed", event_date: "2026-06-01T00:00:00Z" }], next_cursor: null } };
      }
      if (path === "tasks") return { json: { results: [task("x", "old"), task("y", "old", { checked: true })], next_cursor: null } };
      throw new Error(path);
    });
    const snap = snapshot({ joinedAt: "2025-06-01T00:00:00Z" });
    const hist = await fetchHistory(client, snap, new Set(["w", "old"]));

    expect(completedWindows[0][1]).toBe("2026-11-09T02:10:00Z");
    expect(completedWindows.at(-1)![0]).toBe("2025-06-01T00:00:00Z");
    for (const [since, until] of completedWindows) expect(Date.parse(until) - Date.parse(since)).toBeLessThanOrEqual(89 * 86_400_000);
    for (let i = 1; i < completedWindows.length; i++) expect(completedWindows[i][1]).toBe(completedWindows[i - 1][0]);

    expect(activityWindows[0][1]).toBe("2026-11-10");
    expect(activityWindows.at(-1)![0]).toBe("2025-06-01");
    for (const [from, to] of activityWindows) expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(364 * 86_400_000);

    expect(hist.completed.map((t) => t.id)).toEqual(["c1"]); // the same task from every window, once
    expect(hist.events).toHaveLength(1);
    expect(hist.archivedOpen.map((t) => t.id)).toEqual(["x"]);
    expect(hist.problems).toEqual([]);
  });

  it("lists a step that fails and carries on", async () => {
    const { client } = fakeClient((path) => (path === "activities" ? { status: 500, json: null } : { json: { items: [], results: [], next_cursor: null } }));
    const hist = await fetchHistory(client, snapshot(), new Set(["w"]));
    expect(hist.problems).toHaveLength(1);
    expect(hist.problems[0]).toBe("Couldn't read the activity log 2026-01-01 to 2026-11-10: Todoist activities failed (500)");
  });

  it("skips the activity log when the plan has none, and starts it where the plan's history ends", async () => {
    const froms: string[] = [];
    const { client } = fakeClient((path, q) => {
      if (path === "activities") froms.push(q.get("date_from")!);
      return { json: { items: [], results: [], next_cursor: null } };
    });
    const none = await fetchHistory(client, snapshot({ plan: { activity_log: false } }), new Set(["w"]));
    expect(none.activitySkipped).toMatch(/doesn't include/);
    expect(froms).toEqual([]);
    const week = await fetchHistory(client, snapshot({ plan: { activity_log: true, activity_log_limit: 7 } }), new Set(["w"]));
    expect(week.activityFrom).toBe("2026-11-02");
    expect(froms).toEqual(["2026-11-02"]);
  });
});

describe("buildExport", () => {
  it("exports open and completed tasks in the projects picked, with their project's path and the link to a note", () => {
    const snap = snapshot({
      open: [
        task("a", "c", {
          labels: ["Waiting For"],
          priority: 4,
          section_id: "s1",
          due: { date: "2026-11-10T09:00:00", string: "every mon at 9am", is_recurring: true, timezone: "Australia/Sydney" },
          deadline: { date: "2026-11-14" },
          added_at: "2026-10-01T00:00:00Z",
          description: "From [[Meeting]]",
        }),
        task("b", "h"),
      ],
    });
    const hist = history({
      archivedOpen: [task("x", "old")],
      completed: [task("d", "w", { completed_at: "2026-10-02T01:00:00Z" }), task("a", "c", { completed_at: "2026-10-01T00:00:00Z" }), task("e", "h"), task("f", "gone")],
    });
    const state = emptyState();
    state.tasks.a = { path: "Work/Meeting.md", base: { text: "Task a", checked: false, due: null } };
    const links = linkedLines("Work/Meeting.md", "- [ ] Task a %%td:a%% ➕ 2026-09-30 ⏳ 2026-11-10 ^abc123\n");
    const doc = buildExport(snap, hist, new Set(["c", "w", "old"]), links, state, meta);

    expect(doc.tasks.map((t) => [t.id, t.state])).toEqual([["a", "open"], ["x", "open"], ["d", "completed"]]);
    const a = doc.tasks[0];
    expect(a.projectPath).toEqual(["Work", "Clients"]);
    expect(a.sectionName).toBe("Next");
    expect(a.priority).toEqual({ api: 4, label: "p1" });
    expect(a.due).toMatchObject({ date: "2026-11-10", time: "09:00:00", timezone: "Australia/Sydney", string: "every mon at 9am", isRecurring: true });
    expect(a.deadline).toBe("2026-11-14");
    expect(a.url).toBe("https://app.todoist.com/app/task/a");
    expect(a.completedAt).toBeNull();
    expect(a.obsidian).toMatchObject({ pluginLinked: true, pluginNotePath: "Work/Meeting.md", doDate: "2026-11-10", createdDate: "2026-09-30" });
    expect(a.obsidian!.lines[0]).toMatchObject({ line: 1, blockRef: "abc123", blockLink: "[[Work/Meeting#^abc123]]", checkbox: "open" });
    expect(doc.tasks[1].projectArchived).toBe(true);
    expect(doc.tasks[2]).toMatchObject({ completedAt: "2026-10-02T01:00:00Z", obsidian: null, priority: { label: "p4" } });

    expect(doc.coverage.completedTasks.completedInOtherProjects).toBe(1);
    expect(doc.coverage.completedTasks.completedInDeletedProjects).toBe(1);
    expect(doc.coverage.projects.map((p) => p.path.join("/"))).toEqual(["Work", "Work/Clients", "Work/Old work"]);
    expect(doc.counts).toEqual({ open: 2, completed: 1, linkedToNotes: 1, events: 0 });
    expect(doc.exportedAtLocal).toBe("2026-11-09T13:10:00+11:00");
    expect(doc.coverage.complete).toBe(true);
  });

  it("keeps events for the projects picked and for exported tasks, and marks deleted tasks", () => {
    const snap = snapshot({ open: [task("a", "w")] });
    const hist = history({
      completed: [task("d", "w", { completed_at: "2026-10-02T00:00:00Z" })],
      events: [
        { object_type: "item", object_id: "d", event_type: "completed", event_date: "2026-10-02T00:00:00Z", parent_project_id: "w" },
        { object_type: "item", object_id: "d", event_type: "deleted", event_date: "2026-10-03T00:00:00Z", parent_project_id: "w", extra_data: { content: "Task d" } },
        { object_type: "item", object_id: "a", event_type: "completed", event_date: "2026-09-01T00:00:00Z", parent_project_id: "h" },
        { object_type: "item", object_id: "z", event_type: "deleted", event_date: "2026-09-02T00:00:00Z", parent_project_id: "w", extra_data: { content: "Gone" } },
        { object_type: "item", object_id: "q", event_type: "completed", event_date: "2026-09-03T00:00:00Z", parent_project_id: "h" },
      ],
      problems: ["Couldn't read the activity log 2024-11-11 to 2025-11-10: boom"],
    });
    const doc = buildExport(snap, hist, new Set(["w"]), new Map(), emptyState(), meta);
    expect(doc.events.map((e) => [e.taskId, e.event])).toEqual([["d", "deleted"], ["d", "completed"], ["z", "deleted"], ["a", "completed"]]);
    expect(doc.events.find((e) => e.taskId === "z")).toMatchObject({ title: "Gone", taskInExport: false, projectName: "Work" });
    expect(doc.tasks.find((t) => t.id === "d")).toMatchObject({ deleted: true, deletedAt: "2026-10-03T00:00:00Z" });
    expect(doc.coverage.complete).toBe(false);
    expect(doc.coverage.problems).toHaveLength(1);
  });
});

describe("linkedLines", () => {
  it("reads each marked line's fields, cancelled and done included, and skips lines without a marker", () => {
    const note = ["- [x] Done %%td:a%% ✅ 2026-11-01", "- [-] Dropped %%td:b%% ❌ 2026-11-02", "- [ ] No marker", "\t- [ ] Again %%td:a%% 🔁 every week ⏳ 2026-11-03"].join("\n");
    const links = linkedLines("Note.md", note);
    expect([...links.keys()]).toEqual(["a", "b"]);
    expect(links.get("a")!.map((l) => [l.line, l.checkbox, l.doneDate, l.recurrence, l.doDate])).toEqual([
      [1, "done", "2026-11-01", null, null],
      [4, "open", null, "every week", "2026-11-03"],
    ]);
    expect(links.get("b")![0]).toMatchObject({ checkbox: "cancelled", cancelledDate: "2026-11-02", createdDate: null, blockLink: null });
  });
});

describe("projects and dates", () => {
  it("orders projects as the sidebar does, archived after active siblings", () => {
    const tree = projectTreeOrder(snapshot().projects);
    expect(tree.map((p) => `${"-".repeat(p.depth)}${p.name}`)).toEqual(["Inbox", "Work", "-Clients", "-Old work", "Home"]);
    expect(withDescendants(snapshot().projects, "w").sort()).toEqual(["c", "old", "w"]);
  });

  it("writes local times with their offset, and names the file from them", () => {
    const d = new Date("2026-06-30T23:05:00Z");
    expect(localIso(d, "Australia/Sydney")).toBe("2026-07-01T09:05:00+10:00");
    expect(localIso(d, "Not/AZone")).toBe("2026-06-30T23:05:00Z");
    expect(exportFileName(d, "Australia/Sydney")).toBe("Todoist export 2026-07-01 0905.json");
  });
});
