import { generateKeyBetween } from "fractional-indexing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GONE_GRACE_MS, SyncEngine, type EngineSettings, type VaultAdapter } from "../src/sync/engine";
import { blockEnd, setTasksDates, setTasksGlobalFilter, setTasksStatuses, withProjectRef, withRef } from "../src/parse/taskLine";
import { importLines, taskLine, withMissingSubtasks } from "../src/sync/importTask";
import { isoDate } from "../src/sync/dates";
import { fileDate } from "../src/sync/fileDate";
import { emptyState, subtaskCount, type SyncState } from "../src/sync/state";
import { TodoistClient, type Command, type HttpRequest, type TodoistItem } from "../src/todoist/client";

/** In-memory Todoist that understands the handful of sync commands we send. */
class FakeTodoist {
  items = new Map<string, TodoistItem & { seq: number }>();
  seenUuids = new Set<string>();
  seq = 0;
  nextId = 1;
  calls: Command[][] = [];
  /** The sync_token of each pull, `*` for a full sync. */
  syncTokens: string[] = [];
  projects: { id: string; name: string; seq: number; parent_id?: string | null; inbox_project?: boolean; is_archived?: boolean; is_deleted?: boolean }[] = [
    { id: "inbox", name: "Inbox", inbox_project: true, seq: 0 },
    { id: "P2", name: "Work", seq: 0 },
    { id: "PA", name: "Old", is_archived: true, seq: 0 },
  ];
  labels: { id: string; name: string; seq: number }[] = [
    { id: "L1", name: "Waiting For", seq: 0 },
    { id: "L2", name: "PhoneCall", seq: 0 },
  ];

  /**
   * Stands in for Todoist's date parsing: any words → this date (recurring if "every ..."). Words
   * with a date, as for a repeat, take the date as the next occurrence.
   */
  static WORDS_DATE = "2030-01-15";
  private due(d: { date?: string; string?: string; timezone?: string } | null | undefined) {
    if (!d) return null;
    const tz = d.timezone ? { timezone: d.timezone } : {};
    if (d.string) return { date: d.date ?? FakeTodoist.WORDS_DATE, string: d.string, is_recurring: /^every\b/i.test(d.string), ...tz };
    return { date: d.date!, ...tz };
  }
  /** Repeating completions recorded, by task id. */
  completions = new Map<string, number>();
  /** The activity log's completions, newest last. */
  events: { object_type: string; object_id: string; event_type: string; event_date: string; extra_data: Record<string, unknown> }[] = [];
  private logCompletion(id: string, occurrence: string) {
    this.events.push({ object_type: "item", object_id: id, event_type: "completed", event_date: new Date().toISOString(), extra_data: { content: this.items.get(id)!.content, completed_due_date_local: `${occurrence}T23:59:59` } });
  }
  /** Simulate completing a repeating task in the Todoist app: it moves a week on. */
  completeRecurring(id: string) {
    const it = this.items.get(id)!;
    this.logCompletion(id, it.due!.date);
    const next = new Date(`${it.due!.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 7);
    this.edit(id, { due: { ...it.due!, date: next.toISOString().slice(0, 10) } });
  }

  /** An order key after every existing subtask of `parent`, as Todoist gives a task added or moved there. */
  private lastKey(parent: string | null | undefined): string {
    const keys = [...this.items.values()].filter((i) => (i.parent_id ?? null) === (parent ?? null) && i.order_key).map((i) => i.order_key!);
    return generateKeyBetween(keys.sort().at(-1) ?? null, null);
  }

  /** Open subtasks of `parent`, in Todoist's order. */
  kids(parent: string): string[] {
    return [...this.items.values()]
      .filter((i) => i.parent_id === parent && !i.checked)
      .sort((a, b) => (a.order_key! < b.order_key! ? -1 : 1))
      .map((i) => i.id);
  }

  http = async (req: HttpRequest) => {
    if (req.url.includes("/activities")) {
      const q = new URL(req.url).searchParams;
      const types: string[] = JSON.parse(q.get("object_event_types") ?? "[]");
      const results = this.events.filter((e) => e.object_id === q.get("object_id") && (!types.length || types.includes(`${e.object_type}:${e.event_type}`))).reverse();
      return { status: 200, json: { results } };
    }
    const form = new URLSearchParams(req.body);
    const commands: Command[] = form.has("commands") ? JSON.parse(form.get("commands")!) : [];
    this.calls.push(commands);
    const sync_status: Record<string, "ok"> = {};
    const temp_id_mapping: Record<string, string> = {};
    for (const c of commands) {
      sync_status[c.uuid] = "ok";
      if (this.seenUuids.has(c.uuid)) continue; // idempotent, like Todoist
      this.seenUuids.add(c.uuid);
      const a = c.args as Record<string, any>;
      if (typeof a.project_id === "string" && temp_id_mapping[a.project_id]) a.project_id = temp_id_mapping[a.project_id];
      if (typeof a.parent_id === "string" && temp_id_mapping[a.parent_id]) a.parent_id = temp_id_mapping[a.parent_id];
      if (c.type === "label_add") {
        this.labels.push({ id: `LX${this.labels.length}`, name: a.name, seq: ++this.seq });
      } else if (c.type === "project_add") {
        const id = `PX${this.projects.length}`;
        this.projects.push({ id, name: a.name, parent_id: a.parent_id ?? null, seq: ++this.seq });
        if (c.temp_id) temp_id_mapping[c.temp_id] = id;
      } else if (c.type === "item_add") {
        const id = `T${this.nextId++}`;
        const parent = a.parent_id ? this.items.get(a.parent_id) : undefined;
        if (a.parent_id && !parent) throw new Error(`unknown parent ${a.parent_id}`);
        this.items.set(id, {
          id, content: a.content, description: a.description, project_id: a.project_id ?? parent?.project_id ?? "inbox",
          ...(parent ? { parent_id: parent.id } : {}),
          order_key: this.lastKey(parent?.id),
          checked: false, is_deleted: false, priority: a.priority ?? 1, due: this.due(a.due), deadline: a.deadline ?? null, labels: a.labels ?? [], seq: ++this.seq,
        });
        if (c.temp_id) temp_id_mapping[c.temp_id] = id;
      } else {
        const it = this.items.get(a.id)!;
        if (c.type === "item_update") {
          if ("content" in a) it.content = a.content;
          if ("due" in a) it.due = this.due(a.due);
          if ("labels" in a) it.labels = a.labels;
          if ("priority" in a) it.priority = a.priority;
          if ("deadline" in a) it.deadline = a.deadline;
          if ("order_key" in a) it.order_key = a.order_key;
        } else if (c.type === "item_close" && it.due?.is_recurring) {
          // A repeating task moves to its next date (here: a week on) and stays open.
          this.logCompletion(it.id, it.due.date);
          const next = new Date(`${it.due.date}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 7);
          it.due = { ...it.due, date: next.toISOString().slice(0, 10) };
          this.completions.set(it.id, (this.completions.get(it.id) ?? 0) + 1);
        } else if (c.type === "item_update_date_complete") {
          this.logCompletion(it.id, it.due!.date);
          it.due = this.due(a.due);
          this.completions.set(it.id, (this.completions.get(it.id) ?? 0) + 1);
        } else if (c.type === "item_close") it.checked = true;
        else if (c.type === "item_uncomplete") it.checked = false;
        else if (c.type === "item_move" && a.parent_id) {
          it.order_key = this.lastKey(a.parent_id);
          it.parent_id = a.parent_id;
          it.project_id = this.items.get(a.parent_id)!.project_id;
        } else if (c.type === "item_move") {
          it.order_key = this.lastKey(null);
          it.project_id = a.project_id;
          it.parent_id = null;
        }
        it.seq = ++this.seq;
      }
    }
    let items: TodoistItem[] | undefined;
    let full = false;
    if (form.has("resource_types")) {
      this.syncTokens.push(form.get("sync_token") ?? "*");
      const since = form.get("sync_token") === "*" ? 0 : Number(form.get("sync_token"));
      full = since === 0;
      items = [...this.items.values()].filter((i) => i.seq > since);
    }
    return {
      status: 200,
      json: {
        sync_token: String(this.seq), full_sync: full, items,
        projects: this.projects.filter((p) => full || p.seq > Number(form.get("sync_token"))),
        labels: this.labels.filter((l) => full || l.seq > Number(form.get("sync_token"))),
        sync_status, temp_id_mapping,
      },
    };
  };

  /** Like the real API (seen live): the project is reported deleted, its tasks just vanish. */
  deleteProject(id: string) {
    Object.assign(this.projects.find((p) => p.id === id)!, { is_deleted: true, seq: ++this.seq });
    for (const [itemId, it] of this.items) if (it.project_id === id) this.items.delete(itemId);
  }

  /** Simulate an edit in the Todoist app. */
  edit(id: string, patch: Partial<TodoistItem>) {
    Object.assign(this.items.get(id)!, patch, { seq: ++this.seq, updated_at: new Date(Date.now() + 10_000).toISOString() });
  }
}

class FakeVault implements VaultAdapter {
  files = new Map<string, string>();
  fm = new Map<string, Record<string, unknown>>();
  async read(p: string) { return this.files.get(p)!; }
  writes = 0;
  async process(p: string, fn: (c: string) => string) { this.writes++; this.files.set(p, fn(this.files.get(p)!)); }
  mtime() { return Date.now(); }
  frontmatter(p: string) { return this.fm.get(p); }
  markdownFiles() { return [...this.files.keys()]; }
  vaultName() { return "Vault"; }
}

let todoist: FakeTodoist;
let vault: FakeVault;
let state: SyncState;
let settings: EngineSettings;
let engine: SyncEngine;

beforeEach(() => {
  todoist = new FakeTodoist();
  vault = new FakeVault();
  state = { ...emptyState(), backfillDone: true };
  settings = { excludedFolders: ["Templates"], folderProjects: [{ folder: "Work", project: "Work" }], canCreate: true };
  engine = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, state, () => settings, async () => {});
});

const idOf = (line: string) => /%%td:(\w+)%%/.exec(line)?.[1];

describe("SyncEngine", () => {
  it("creates new checkboxes in Todoist and writes the id back", async () => {
    vault.files.set("Note.md", "# Hi\n- [ ] Call Bob ⏳ 2026-11-10\n- [x] Old done thing\n- [ ] Secret #notodoist");
    await engine.pushFile("Note.md");
    const lines = vault.files.get("Note.md")!.split("\n");
    expect(lines[1]).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-10");
    expect(lines[2]).toBe("- [x] Old done thing"); // already-checked lines are never created
    expect(lines[3]).toBe("- [ ] Secret #notodoist");
    const item = todoist.items.get("T1")!;
    expect(item.content).toBe("Call Bob");
    expect(item.due).toEqual({ date: "2026-11-10" });
    expect(item.description).toContain("obsidian://open?vault=Vault&file=Note.md");
    expect(state.pending).toEqual({});
  });

  it("does not create the task on the line being edited", async () => {
    vault.files.set("Note.md", "- [ ] Call B");
    const r = await engine.pushFile("Note.md", { skipLine: 0 });
    expect(r.deferred).toBe(true);
    expect(todoist.items.size).toBe(0);
  });

  it("waits while the editor has unsaved changes, so a half-typed line is never created", async () => {
    // Saved after the user paused at "#not"; they then pressed Enter, which isn't saved yet.
    vault.files.set("Note.md", "- [ ] done\n- [ ] Test Tag #not");
    const editor = { content: "- [ ] done\n- [ ] Test Tag #not\n- [ ] ", cursorLine: 2 };
    const r = await engine.pushFile("Note.md", { editor: () => editor });
    expect(r.deferred).toBe(true);
    expect(todoist.items.size).toBe(0);

    // Back on the line, finishing the tag; Obsidian saves, so disk and editor agree again.
    editor.content = "- [ ] done\n- [ ] Test Tag #notodoist";
    editor.cursorLine = 1;
    vault.files.set("Note.md", editor.content);
    await engine.pushFile("Note.md", { editor: () => editor });
    expect([...todoist.items.values()].map((i) => i.content)).toEqual(["done"]);
  });

  it("respects excluded folders, frontmatter opt-out and backfill gate", async () => {
    vault.files.set("Templates/Daily.md", "- [ ] template task");
    vault.files.set("Private.md", "- [ ] private");
    vault.fm.set("Private.md", { todoist: false });
    await engine.pushFile("Templates/Daily.md");
    await engine.pushFile("Private.md");
    state.backfillDone = false;
    vault.files.set("Note.md", "- [ ] before backfill");
    await engine.pushFile("Note.md");
    expect(todoist.items.size).toBe(0);
  });

  it("routes to a project by folder mapping or frontmatter", async () => {
    await engine.pull(); // loads projects
    vault.files.set("Work/Meeting.md", "- [ ] Follow up");
    vault.files.set("Home.md", "- [ ] Fix tap");
    vault.fm.set("Home.md", { todoist_project: "work" });
    await engine.pushFile("Work/Meeting.md");
    await engine.pushFile("Home.md");
    expect([...todoist.items.values()].map((i) => i.project_id)).toEqual(["P2", "P2"]);
  });

  it("pushes completion, text and due edits from the note", async () => {
    vault.files.set("Note.md", "- [ ] Call Bob");
    await engine.pushFile("Note.md");
    vault.files.set("Note.md", "- [x] Call Bob about contract %%td:T1%% ⏳ 2026-12-01");
    await engine.pushFile("Note.md");
    expect(todoist.items.get("T1")).toMatchObject({ checked: true, content: "Call Bob about contract", due: { date: "2026-12-01" } });
    // nothing further to push
    const before = todoist.calls.length;
    await engine.pushFile("Note.md");
    expect(todoist.calls.length).toBe(before);
  });

  it("pulls completion and edits from Todoist into the note", async () => {
    vault.files.set("Note.md", "intro\n  - [ ] Call Bob\noutro");
    await engine.pushFile("Note.md");
    await engine.pull();
    todoist.edit("T1", { checked: true, content: "Call Bob!", due: { date: "2026-11-20T09:00:00" } });
    await engine.pull();
    expect(vault.files.get("Note.md")).toBe("intro\n  - [x] Call Bob! %%td:T1%% ⏳ 2026-11-20\noutro");
  });

  it("does not rewrite the note when a pull changes nothing on its lines", async () => {
    vault.files.set("Note.md", "- [ ] Call Bob");
    await engine.pushFile("Note.md");
    await engine.pull();
    todoist.edit("T1", { priority: 4 }); // remote-only field
    const before = vault.writes;
    await engine.pull();
    expect(vault.writes).toBe(before);
    expect(state.remote["T1"].priority).toBe(4);
    expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%%");
  });

  it("merges independent edits on both sides", async () => {
    vault.files.set("Note.md", "- [ ] Call Bob");
    await engine.pushFile("Note.md");
    await engine.pull();
    todoist.edit("T1", { checked: true });
    vault.files.set("Note.md", "- [ ] Call Bob re contract %%td:T1%%"); // local text edit, not yet pushed
    await engine.pull();
    expect(vault.files.get("Note.md")).toBe("- [x] Call Bob re contract %%td:T1%%");
    expect(todoist.items.get("T1")!.content).toBe("Call Bob re contract");
  });

  it("never deletes: removed lines unlink, Todoist deletions orphan", async () => {
    vault.files.set("A.md", "- [ ] one\n- [ ] two");
    await engine.pushFile("A.md");
    vault.files.set("A.md", "- [ ] two %%td:T2%%");
    await engine.pushFile("A.md");
    expect(state.tasks["T1"]).toBeUndefined();
    expect(todoist.items.get("T1")!.is_deleted).toBe(false);

    await engine.pull();
    todoist.edit("T2", { is_deleted: true });
    await engine.pull();
    expect(state.tasks["T2"].orphaned).toBe(true);
    expect(vault.files.get("A.md")).toBe("- [ ] two %%td:T2%%");
  });

  it("orphans tasks whose project was deleted in Todoist", async () => {
    await engine.pull();
    vault.files.set("Note.md", "- [ ] in work #[Work]\n- [ ] moved out #[Work]\n- [ ] in inbox");
    await engine.pushFile("Note.md");
    await engine.pull();
    todoist.edit("T2", { project_id: "inbox" }); // moved out before the project goes
    todoist.deleteProject("P2");
    await engine.pull();
    expect(state.tasks["T1"].orphaned).toBe(true);
    expect(state.tasks["T2"].orphaned).toBeFalsy();
    expect(state.tasks["T3"].orphaned).toBeFalsy();
    expect(vault.files.get("Note.md")).toBe("- [ ] in work %%td:T1%%\n- [ ] moved out %%td:T2%%\n- [ ] in inbox %%td:T3%%");
  });

  it("re-adopts a task moved to another note", async () => {
    vault.files.set("A.md", "- [ ] move me");
    await engine.pushFile("A.md");
    vault.files.set("A.md", "");
    vault.files.set("B.md", "- [ ] move me %%td:T1%%");
    await engine.pushFile("A.md");
    await engine.pushFile("B.md");
    expect(state.tasks["T1"].path).toBe("B.md");
  });

  it("retries a pending create idempotently and resolves via backlink on pull", async () => {
    vault.files.set("Note.md", "- [ ] flaky");
    // First attempt: Todoist applies the command but the response is lost.
    const realHttp = todoist.http;
    todoist.http = async (req) => { await realHttp(req); throw new Error("network"); };
    engine = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, state, () => settings, async () => {});
    await expect(engine.pushFile("Note.md")).rejects.toThrow("network");
    expect(vault.files.get("Note.md")).toMatch(/%%td:new-[0-9a-f-]{36}%%/);

    todoist.http = realHttp;
    engine = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, state, () => settings, async () => {});
    await engine.pushFile("Note.md"); // same uuid → deduped, no mapping returned
    expect(todoist.items.size).toBe(1);
    await engine.pull();
    expect(idOf(vault.files.get("Note.md")!)).toBe("T1");
    expect(state.pending).toEqual({});
  });

  describe("#[Project] references", () => {
    const projectOf = (id: string) => todoist.items.get(id)!.project_id;

    it("files a new task in the named project and strips the reference", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Send invoice #[work] ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      expect(projectOf("T1")).toBe("P2"); // matched ignoring case
      expect(todoist.items.get("T1")!.content).toBe("Send invoice");
      expect(vault.files.get("Note.md")).toBe("- [ ] Send invoice %%td:T1%% ⏳ 2026-11-10");
    });

    it("creates nested projects from a path, each level once, under one that exists", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] one #[Work/Clients/Acme]\n- [ ] two #[work / clients / Beta]");
      await engine.pushFile("Note.md");
      const byName = (n: string) => todoist.projects.filter((p) => p.name === n);
      expect(byName("Clients")).toHaveLength(1);
      const [clients, acme, beta] = [byName("Clients")[0], byName("Acme")[0], byName("Beta")[0]];
      expect([clients.parent_id, acme.parent_id, beta.parent_id]).toEqual(["P2", clients.id, clients.id]);
      expect([projectOf("T1"), projectOf("T2")]).toEqual([acme.id, beta.id]);
      expect(state.projects[acme.id]).toMatchObject({ name: "Acme", parentId: clients.id });
      expect(vault.files.get("Note.md")).toBe("- [ ] one %%td:T1%%\n- [ ] two %%td:T2%%");

      // Named again, by path or by name: found, not created.
      await engine.pull();
      vault.files.set("Note.md", "- [ ] one %%td:T1%%\n- [ ] two %%td:T2%%\n- [ ] three #[Work/Clients/Acme]\n- [ ] four #[Clients/Beta]");
      await engine.pushFile("Note.md");
      expect([projectOf("T3"), projectOf("T4")]).toEqual([acme.id, beta.id]);
      expect(byName("Acme")).toHaveLength(1);
      expect(byName("Clients")).toHaveLength(1);
    });

    it("creates a missing project once, even when several lines name it", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] one #[Home Reno]\n- [ ] two #[home  reno]");
      await engine.pushFile("Note.md");
      const created = todoist.projects.filter((p) => p.name === "Home Reno");
      expect(created).toHaveLength(1);
      expect([projectOf("T1"), projectOf("T2")]).toEqual([created[0].id, created[0].id]);
      expect(state.projects[created[0].id].name).toBe("Home Reno");
      expect(state.pendingProjects).toEqual({});
      expect(vault.files.get("Note.md")).toBe("- [ ] one %%td:T1%%\n- [ ] two %%td:T2%%");
    });

    it("does not file into an archived project of the same name", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] revive #[Old]");
      await engine.pushFile("Note.md");
      expect(projectOf("T1")).not.toBe("PA");
      expect(todoist.projects.filter((p) => p.name === "Old")).toHaveLength(2);
    });

    it("moves a synced task when a reference is added, then strips it", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob #[Work] %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(projectOf("T1")).toBe("P2");
      expect(state.remote["T1"].projectId).toBe("P2"); // chip updates before the next pull
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%%");
      expect(todoist.items.get("T1")!.content).toBe("Call Bob"); // the reference never reaches the task text
    });

    it("moves a dated task to the project picked on its chip, and back to the Inbox", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      await engine.pull();
      const pick = (name: string) => vault.files.set("Note.md", withProjectRef(vault.files.get("Note.md")!, name));
      pick("Work");
      await engine.pushFile("Note.md");
      expect(projectOf("T1")).toBe("P2");
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-10");
      pick("Inbox");
      await engine.pushFile("Note.md");
      expect(projectOf("T1")).toBe("inbox");
      expect(state.remote["T1"].projectId).toBe("inbox");
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-10");
      expect(todoist.items.get("T1")!.content).toBe("Call Bob");
    });

    it("leaves the reference alone while the cursor is on the line", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", "- [ ] Call Bob #[Work] %%td:T1%%");
      const r = await engine.pushFile("Note.md", { skipLine: 0 });
      expect(r.deferred).toBe(true);
      expect(projectOf("T1")).toBe("inbox");
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob #[Work] %%td:T1%%");
    });

    it("keeps the reference through a pull that rewrites the line", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob #[Work] %%td:T1%%");
      todoist.edit("T1", { checked: true });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [x] Call Bob #[Work] %%td:T1%%");
    });

    it("holds a task whose project create got no answer until a pull settles it", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] tile quote #[Bathroom]");
      const realHttp = todoist.http;
      todoist.http = async (req) => { await realHttp(req); throw new Error("network"); };
      engine = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, state, () => settings, async () => {});
      await expect(engine.pushFile("Note.md")).rejects.toThrow("network");
      expect(Object.keys(state.pendingProjects)).toEqual(["bathroom"]);

      todoist.http = realHttp;
      engine = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, state, () => settings, async () => {});
      expect((await engine.pushFile("Note.md")).deferred).toBe(true); // waits rather than re-create
      await engine.pull(); // brings in the project and the task created by the lost request
      await engine.pushFile("Note.md");
      expect(todoist.projects.filter((p) => p.name === "Bathroom")).toHaveLength(1);
      expect(todoist.items.size).toBe(1);
      expect(vault.files.get("Note.md")).toBe("- [ ] tile quote %%td:T1%%");
    });

    it("does not create projects on a device with creation disabled", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      settings.canCreate = false;
      vault.files.set("Note.md", "- [ ] Call Bob #[Garden] %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.projects.some((p) => p.name === "Garden")).toBe(false);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob #[Garden] %%td:T1%%");
    });
  });

  describe("p1–p4 priorities", () => {
    it("creates a task with its priority and strips it", async () => {
      vault.files.set("Note.md", "- [ ] Call the dentist p1 @PhoneCall ⏳ 2026-11-10");
      await engine.pull();
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ content: "Call the dentist", priority: 4, labels: ["PhoneCall"] });
      expect(vault.files.get("Note.md")).toBe("- [ ] Call the dentist %%td:T1%% ⏳ 2026-11-10");
      expect(state.remote.T1.priority).toBe(4);
    });

    it("changes a synced task's priority, and p4 clears it", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob p2");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.priority).toBe(3);
      vault.files.set("Note.md", "- [ ] Call Bob p4 %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.priority).toBe(1);
      expect(todoist.items.get("T1")!.content).toBe("Call Bob");
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%%");
    });

    it("sets the priority picked on the chip on a dated subtask, and p4 clears it", async () => {
      vault.files.set("Note.md", "- [ ] Trip\n\t- [ ] Book train ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      await engine.pull();
      const pick = (p: number) => {
        const lines = vault.files.get("Note.md")!.split("\n");
        lines[1] = withRef(lines[1], `p${p}`);
        vault.files.set("Note.md", lines.join("\n"));
      };
      pick(1);
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T2")).toMatchObject({ priority: 4, content: "Book train", parent_id: "T1" });
      expect(state.remote.T2.priority).toBe(4); // chip updates before the next pull
      expect(vault.files.get("Note.md")).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] Book train %%td:T2%% ⏳ 2026-11-10");
      pick(4);
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T2")!.priority).toBe(1);
      expect(vault.files.get("Note.md")).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] Book train %%td:T2%% ⏳ 2026-11-10");
    });

    it("leaves it on the line while the line is being edited", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", "- [ ] Call Bob p1 %%td:T1%%");
      expect((await engine.pushFile("Note.md", { skipLine: 0 })).deferred).toBe(true);
      expect(todoist.items.get("T1")!.priority).toBe(1);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob p1 %%td:T1%%");
    });

    it("strips it without sending anything when the task already has that priority", async () => {
      await engine.pull(); // knows the Inbox, so the new task's details are recorded
      vault.files.set("Note.md", "- [ ] Call Bob p3");
      await engine.pushFile("Note.md");
      const calls = todoist.calls.length;
      vault.files.set("Note.md", "- [ ] Call Bob p3 %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.calls.length).toBe(calls);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%%");
    });
  });

  describe("nested checkboxes as subtasks", () => {
    const parentOf = (content: string) => [...todoist.items.values()].find((i) => i.content === content)?.parent_id;

    it("creates a line nested under a synced task as its subtask, in its project", async () => {
      await engine.pull(); // learn the projects
      vault.files.set("Note.md", "- [ ] Plan trip #[Work]");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", vault.files.get("Note.md")! + "\n\t- [ ] Book hotel\n    - [ ] Book flights");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T2")).toMatchObject({ content: "Book hotel", parent_id: "T1", project_id: "P2" });
      expect(todoist.items.get("T3")).toMatchObject({ content: "Book flights", parent_id: "T1", project_id: "P2" });
      expect(state.remote["T2"]?.projectId).toBe("P2"); // chip known without a pull
    });

    it("creates a new task and its new subtasks together, nested any depth", async () => {
      vault.files.set("Note.md", "- [ ] Plan trip\n\t- [ ] Book flights\n\t\t- [ ] Pick seats\n\t- [ ] Book hotel");
      await engine.pushFile("Note.md");
      expect(todoist.calls.length).toBe(1); // one request
      expect(parentOf("Plan trip")).toBeUndefined();
      expect(parentOf("Book flights")).toBe("T1");
      expect(parentOf("Pick seats")).toBe("T2");
      expect(parentOf("Book hotel")).toBe("T1");
      expect(vault.files.get("Note.md")).toBe(
        "- [ ] Plan trip %%td:T1%%\n\t- [ ] Book flights %%td:T2%%\n\t\t- [ ] Pick seats %%td:T3%%\n\t- [ ] Book hotel %%td:T4%%",
      );
    });

    it("waits for a parent that's still being typed", async () => {
      vault.files.set("Note.md", "- [ ] Plan tr\n\t- [ ] Book hotel");
      const r = await engine.pushFile("Note.md", { skipLine: 0 });
      expect(r.deferred).toBe(true);
      expect(todoist.items.size).toBe(0);
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("Plan tr", "Plan trip"));
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.content).toBe("Plan trip");
      expect(parentOf("Book hotel")).toBe("T1");
    });

    it("makes top-level tasks of lines not nested under a syncing checkbox", async () => {
      await engine.pull(); // learn the projects
      vault.files.set(
        "Note.md",
        ["- Shopping", "\t- [ ] Milk", "- [ ] Private #notodoist", "\t- [ ] Eggs", "- [ ] Trip", "\t- [ ] Book train #[Work]", "", "  Some text", "- [ ] Bread"].join("\n"),
      );
      await engine.pushFile("Note.md");
      for (const c of ["Milk", "Eggs", "Book train", "Bread"]) expect(parentOf(c)).toBeUndefined();
      expect([...todoist.items.values()].find((i) => i.content === "Book train")!.project_id).toBe("P2");
    });

    it("moves a new nested line with a #[Project] out of its block, as a top-level task there", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Trip\n\t- [ ] Book train #[Work]\n\t- [ ] Pack");
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] Pack %%td:T3%%\n- [ ] Book train %%td:T2%%");
      const calls = todoist.calls.length;
      await engine.pushFile("Note.md");
      expect(todoist.calls.length).toBe(calls);
      expect(parentOf("Book train")).toBeUndefined();
      expect(todoist.items.get("T2")!.project_id).toBe("P2");
    });

    it("moves a synced subtask filed in another project out of its block, with its own subtasks", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Trip\n\t- [ ] Book train\n\t\t- [ ] Seats\n\t- [ ] Pack");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("Book train", "Book train #[Work]"));
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T2")).toMatchObject({ project_id: "P2", parent_id: null });
      expect(vault.files.get("Note.md")).toBe(
        "- [ ] Trip %%td:T1%%\n\t- [ ] Pack %%td:T4%%\n- [ ] Book train %%td:T2%%\n\t- [ ] Seats %%td:T3%%",
      );
      const calls = todoist.calls.length;
      await engine.pull();
      await engine.pushFile("Note.md");
      expect(todoist.calls.length).toBe(calls + 1); // just the pull: nothing moved back
    });
  });

  describe("indenting and moving synced lines", () => {
    const parentOf = (id: string) => todoist.items.get(id)?.parent_id ?? null;
    const edit = (from: string, to: string) => vault.files.set("Note.md", vault.files.get("Note.md")!.replace(from, to));
    const moves = () => todoist.calls.flat().filter((c) => c.type === "item_move").map((c) => c.args);
    /** Indent "Book hotel" and its subtasks one level, as Obsidian's Tab on a list item does. */
    const indentHotel = (above = "") =>
      edit("- [ ] Book hotel", `${above}\t- [ ] Book hotel`) &&
      edit("\t- [ ] Book flights", "\t\t- [ ] Book flights") &&
      edit("\t\t- [ ] Pick seats", "\t\t\t- [ ] Pick seats");

    beforeEach(async () => {
      await engine.pull();
      // T1 Plan trip (Work), T2 Book hotel, T3 Book flights (subtask of T1), T4 Pick seats (of T3)
      vault.files.set("Note.md", "- [ ] Plan trip #[Work]\n- [ ] Book hotel\n\t- [ ] Book flights\n\t\t- [ ] Pick seats");
      await engine.pushFile("Note.md");
      expect([parentOf("T2"), parentOf("T3"), parentOf("T4")]).toEqual([null, "T2", "T3"]);
    });

    it("makes an indented line a subtask of the task above, in that task's project", async () => {
      indentHotel();
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([{ id: "T2", parent_id: "T1" }]); // its subtasks move with it
      expect(todoist.items.get("T2")).toMatchObject({ parent_id: "T1", project_id: "P2" });
      expect(state.remote["T2"]).toMatchObject({ parentId: "T1", projectId: "P2" });
      await engine.pushFile("Note.md");
      expect(moves().length).toBe(1); // once
    });

    it("makes an outdented line a top-level task in its project", async () => {
      edit("\t\t- [ ] Pick seats", "- [ ] Pick seats");
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([{ id: "T4", project_id: "inbox" }]);
      expect(parentOf("T4")).toBeNull();
    });

    it("moves a line to the task it's now nested under", async () => {
      edit("\t\t- [ ] Pick seats", "\t- [ ] Pick seats");
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([{ id: "T4", parent_id: "T2" }]);
    });

    it("moves the line out to the top level for a task made top-level in Todoist", async () => {
      todoist.edit("T4", { parent_id: null });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(
        "- [ ] Plan trip %%td:T1%%\n- [ ] Book hotel %%td:T2%%\n\t- [ ] Book flights %%td:T3%%\n- [ ] Pick seats %%td:T4%%",
      );
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([]); // not sent back
      expect(parentOf("T4")).toBeNull();
    });

    it("moves the line, with its subtasks, under the task it was moved under in Todoist", async () => {
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("- [ ] Plan trip %%td:T1%%", "- [ ] Plan trip %%td:T1%%\n\t- [ ] Visa"));
      await engine.pushFile("Note.md"); // T5 Visa, under T1
      todoist.edit("T2", { parent_id: "T1", order_key: generateKeyBetween(null, todoist.items.get("T5")!.order_key!) });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(
        "- [ ] Plan trip %%td:T1%%\n\t- [ ] Book hotel %%td:T2%%\n\t\t- [ ] Book flights %%td:T3%%\n\t\t\t- [ ] Pick seats %%td:T4%%\n\t- [ ] Visa %%td:T5%%",
      );
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([]);
    });

    it("keeps the note's nesting when it was changed in both places", async () => {
      todoist.edit("T4", { parent_id: null }); // out to the top level, in Todoist
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("\t\t- [ ] Pick seats", "\t- [ ] Pick seats")); // under T2, here
      await engine.pull();
      expect(vault.files.get("Note.md")).toContain("\n\t- [ ] Pick seats %%td:T4%%");
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([{ id: "T4", parent_id: "T2" }]);
    });

    it("leaves the line where it is when moved under a task that isn't in the note", async () => {
      todoist.items.set("T9", { id: "T9", content: "Elsewhere", description: "", project_id: "inbox", checked: false, is_deleted: false, priority: 1, due: null, seq: ++todoist.seq });
      todoist.edit("T4", { parent_id: "T9" });
      const before = vault.files.get("Note.md");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(before);
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([]); // nor moved back
    });

    it("moves a completed task only once it's unticked", async () => {
      edit("\t\t- [ ] Pick seats", "- [x] Pick seats");
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([]);
      edit("- [x] Pick seats", "- [ ] Pick seats");
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([{ id: "T4", project_id: "inbox" }]);
    });

    it("waits to move a line under a new task until that task is created", async () => {
      indentHotel("- [ ] Hotels\n");
      const r = await engine.pushFile("Note.md");
      expect(r.deferred).toBe(true);
      expect(moves()).toEqual([]);
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([{ id: "T2", parent_id: "T5" }]);
    });

    it("fetches the parent of tasks synced before parents were tracked, then moves them", async () => {
      for (const meta of Object.values(state.remote)) delete meta.parentId; // as saved by an older version
      for (const rec of Object.values(state.tasks)) delete rec.parent;
      await engine.pushFile("Note.md"); // first sight: nesting noted
      expect(engine.missingDetails().sort()).toEqual(["T1", "T2", "T3", "T4"]);
      edit("\t\t- [ ] Pick seats", "- [ ] Pick seats");
      expect((await engine.pushFile("Note.md")).deferred).toBe(true);
      expect(moves()).toEqual([]);
      await engine.pull(); // full sync, for the missing details
      expect(state.remote["T4"].parentId).toBe("T3");
      expect(engine.missingDetails()).toEqual([]);
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([{ id: "T4", project_id: "inbox" }]);
    });

    it("takes an imported or pasted line's nesting as it finds it", async () => {
      todoist.items.set("T9", { id: "T9", content: "Pack", description: "", project_id: "P2", checked: false, is_deleted: false, priority: 1, due: null, parent_id: "T1", seq: ++todoist.seq });
      edit("- [ ] Book hotel", "- [ ] Pack %%td:T9%%\n- [ ] Book hotel");
      await engine.pushFile("Note.md");
      await engine.pull();
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([]);
      expect(parentOf("T9")).toBe("T1");
    });
  });

  describe("subtask order", () => {
    const keyOf = (id: string) => todoist.items.get(id)!.order_key!;
    const reorders = () => todoist.calls.flat().filter((c) => c.type === "item_update" && "order_key" in c.args);
    const note = () => vault.files.get("Note.md")!;

    beforeEach(async () => {
      await engine.pull();
      // T1 Trip; T2 A, T3 B (with T4 B1 under it), T5 C
      vault.files.set("Note.md", "- [ ] Trip\n\t- [ ] A\n\t- [ ] B\n\t\t- [ ] B1\n\t- [ ] C");
      await engine.pushFile("Note.md");
      expect(todoist.kids("T1")).toEqual(["T2", "T3", "T5"]);
      expect(reorders()).toEqual([]);
    });

    it("sends a reorder made in the note, moving only the task that moved", async () => {
      vault.files.set("Note.md", "- [ ] Trip %%td:T1%%\n\t- [ ] C %%td:T5%%\n\t- [ ] A %%td:T2%%\n\t- [ ] B %%td:T3%%\n\t\t- [ ] B1 %%td:T4%%");
      await engine.pushFile("Note.md");
      expect(todoist.kids("T1")).toEqual(["T5", "T2", "T3"]);
      expect(reorders().map((c) => c.args.id)).toEqual(["T5"]);
      await engine.pull();
      await engine.pushFile("Note.md");
      expect(reorders().length).toBe(1); // settled
      expect(note()).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] C %%td:T5%%\n\t- [ ] A %%td:T2%%\n\t- [ ] B %%td:T3%%\n\t\t- [ ] B1 %%td:T4%%");
    });

    it("rearranges the lines for a reorder made in Todoist, with what's nested under them", async () => {
      todoist.edit("T5", { order_key: generateKeyBetween(null, keyOf("T2")) });
      await engine.pull();
      expect(note()).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] C %%td:T5%%\n\t- [ ] A %%td:T2%%\n\t- [ ] B %%td:T3%%\n\t\t- [ ] B1 %%td:T4%%");
      await engine.pushFile("Note.md");
      expect(reorders()).toEqual([]); // nothing sent back
    });

    it("lets the note win when both sides were reordered", async () => {
      todoist.edit("T5", { order_key: generateKeyBetween(null, keyOf("T2")) }); // C first, in Todoist
      vault.files.set("Note.md", note().replace("\t- [ ] A %%td:T2%%\n", "").replace("\t- [ ] C %%td:T5%%", "\t- [ ] C %%td:T5%%\n\t- [ ] A %%td:T2%%"));
      await engine.pushFile("Note.md"); // B, C, A in the note
      expect(todoist.kids("T1")).toEqual(["T3", "T5", "T2"]);
      await engine.pull();
      expect(note()).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] B %%td:T3%%\n\t\t- [ ] B1 %%td:T4%%\n\t- [ ] C %%td:T5%%\n\t- [ ] A %%td:T2%%");
    });

    it("leaves subtasks that aren't in the note in their places", async () => {
      todoist.items.set("X", {
        id: "X", content: "Not in note", description: "", project_id: "inbox", checked: false, is_deleted: false, priority: 1, due: null,
        parent_id: "T1", order_key: generateKeyBetween(keyOf("T2"), keyOf("T3")), seq: ++todoist.seq,
      });
      await engine.pull();
      vault.files.set("Note.md", note().replace("\t- [ ] A %%td:T2%%\n", "").replace("\t\t- [ ] B1 %%td:T4%%", "\t\t- [ ] B1 %%td:T4%%\n\t- [ ] A %%td:T2%%"));
      await engine.pushFile("Note.md"); // B, A, C in the note
      const kids = todoist.kids("T1");
      expect(kids.filter((k) => k !== "X")).toEqual(["T3", "T2", "T5"]);
      expect(reorders().length).toBe(1); // one task moved
      // X keeps its place relative to the tasks that didn't move (A and C here).
      expect(kids.indexOf("T2") < kids.indexOf("X") && kids.indexOf("X") < kids.indexOf("T5")).toBe(true);
    });

    it("puts a subtask typed between others in its place", async () => {
      vault.files.set("Note.md", note().replace("\t- [ ] B %%td:T3%%", "\t- [ ] A2\n\t- [ ] B %%td:T3%%"));
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T6")!.content).toBe("A2");
      expect(todoist.kids("T1")).toEqual(["T2", "T6", "T3", "T5"]);
    });

    it("doesn't rearrange lines with other text among them", async () => {
      vault.files.set("Note.md", note().replace("\t- [ ] C", "\tA note about C\n\t- [ ] C"));
      await engine.pushFile("Note.md");
      todoist.edit("T5", { order_key: generateKeyBetween(null, keyOf("T2")) });
      const before = note();
      await engine.pull();
      expect(note()).toBe(before);
      await engine.pull();
      await engine.pushFile("Note.md");
      expect(note()).toBe(before);
      expect(reorders()).toEqual([]); // nor is the note's order forced on Todoist
    });
  });

  describe("subtask counts", () => {
    const item = (id: string, content: string, extra: Partial<TodoistItem> = {}) =>
      todoist.items.set(id, {
        id, content, description: "", project_id: "inbox", checked: false, is_deleted: false, priority: 1, due: null,
        seq: ++todoist.seq, ...extra,
      });

    it("counts open subtasks from Todoist, linked to a note or not", async () => {
      vault.files.set("Note.md", "- [ ] Plan trip");
      await engine.pushFile("Note.md"); // T1
      item("X1", "Book hotel", { parent_id: "T1" });
      item("X2", "Book flights", { parent_id: "T1" });
      item("X3", "Pick seats", { parent_id: "X2" }); // a subtask's subtask isn't counted
      item("X4", "Done one", { parent_id: "T1", checked: true });
      await engine.pull();
      expect(subtaskCount(state, "T1")).toBe(2);
      expect(subtaskCount(state, "X2")).toBe(1);

      // Changes in Todoist reach it on the next (incremental) pull.
      todoist.edit("X1", { checked: true });
      todoist.edit("X4", { checked: false });
      item("X5", "Pack", { parent_id: "T1" });
      todoist.edit("X2", { parent_id: null });
      await engine.pull();
      expect(subtaskCount(state, "T1")).toBe(2); // X4, X5
    });

    it("updates the count straight away for changes sent from the note", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Plan trip\n\t- [ ] Book hotel\n\t- [ ] Book flights");
      await engine.pushFile("Note.md");
      expect(subtaskCount(state, "T1")).toBe(2);
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("- [ ] Book hotel", "- [x] Book hotel"));
      await engine.pushFile("Note.md");
      expect(subtaskCount(state, "T1")).toBe(1);
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("\t- [ ] Book flights", "- [ ] Book flights"));
      await engine.pushFile("Note.md");
      expect(subtaskCount(state, "T1")).toBe(0);
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("- [x] Book hotel", "- [ ] Book hotel"));
      await engine.pushFile("Note.md");
      expect(subtaskCount(state, "T1")).toBe(1);
    });

    it("fills in counts once for state saved before they were tracked", async () => {
      item("X1", "Book hotel", { parent_id: "T9" });
      await engine.pull();
      delete (state as Partial<SyncState>).subtasks;
      delete state.subtasksSynced;
      todoist.calls.length = 0;
      await engine.pull();
      expect(subtaskCount(state, "T9")).toBe(1);
    });
  });

  describe("importing from Todoist", () => {
    const add = (id: string, content: string, extra: Partial<TodoistItem> = {}) =>
      todoist.items.set(id, {
        id, content, description: "", project_id: "P2", checked: false, is_deleted: false, priority: 1, due: null,
        labels: [], seq: ++todoist.seq, ...extra,
      });

    it("lists open tasks and builds lines with subtasks in Todoist's order", async () => {
      add("A", "Plan trip today", { due: { date: "2030-02-01" }, priority: 4, labels: ["PhoneCall"] });
      add("B", "Book hotel", { parent_id: "A", child_order: 2 });
      add("C", "Book flights", { parent_id: "A", child_order: 1 });
      add("D", "Pick seats", { parent_id: "C", child_order: 1 });
      add("E", "Done already", { checked: true });
      add("F", "Linked elsewhere", { parent_id: "A", child_order: 3 });
      state.tasks["F"] = { path: "Other.md", base: { text: "Linked elsewhere", checked: false, due: null } };
      const before = state.syncToken;

      const open = await engine.openTasks();
      expect(open.map((i) => i.id).sort()).toEqual(["A", "B", "C", "D", "F"]);
      expect(state.syncToken).toBe(before); // a pull still sees everything since the last one

      const { lines, items } = importLines(open.find((i) => i.id === "A")!, open, (id) => engine.isLinked(id), "  ", "\t");
      expect(lines).toEqual([
        "  - [ ] Plan trip today %%td:A%% ⏳ 2030-02-01",
        "  \t- [ ] Book flights %%td:C%%",
        "  \t\t- [ ] Pick seats %%td:D%%",
        "  \t- [ ] Book hotel %%td:B%%",
      ]);
      expect(items.map((i) => i.id)).toEqual(["A", "C", "D", "B"]);

      // Without subtasks: just the task.
      const alone = importLines(open.find((i) => i.id === "A")!, open, (id) => engine.isLinked(id), "", "\t", false);
      expect(alone.lines).toEqual(["- [ ] Plan trip today %%td:A%% ⏳ 2030-02-01"]);
      expect(alone.items.map((i) => i.id)).toEqual(["A"]);
      // Writing Tasks fields: the priority comes too.
      const tasks = importLines(open.find((i) => i.id === "A")!, open, (id) => engine.isLinked(id), "", "\t", false, true);
      expect(tasks.lines).toEqual(["- [ ] Plan trip today %%td:A%% 🔺 ⏳ 2030-02-01"]);
    });

    it("adds a synced task's missing subtasks where Todoist has them", async () => {
      add("A", "Plan trip");
      add("B", "Book hotel", { parent_id: "A", order_key: "a2" });
      add("C", "Book flights", { parent_id: "A", order_key: "a1" });
      add("D", "Pick seats", { parent_id: "C", order_key: "a0" });
      add("E", "Pack", { parent_id: "A", order_key: "a3" });
      add("F", "Visa", { parent_id: "A", order_key: "a0" });
      for (const id of ["A", "B"]) state.tasks[id] = { path: "Note.md", base: { text: "", checked: false, due: null } };
      const open = await engine.openTasks();
      const note = ["# Trip", "  - [ ] Plan trip %%td:A%%", "  \t- [ ] Book hotel %%td:B%%", "  \t\tnotes on hotels", "- [ ] Other"];
      const { lines, added } = withMissingSubtasks(note, 1, "A", open, (id) => engine.isLinked(id), "\t");
      expect(lines).toEqual([
        "# Trip",
        "  - [ ] Plan trip %%td:A%%",
        "  \t- [ ] Visa %%td:F%%", // first in Todoist: before Book hotel
        "  \t- [ ] Book flights %%td:C%%",
        "  \t\t- [ ] Pick seats %%td:D%%",
        "  \t- [ ] Book hotel %%td:B%%",
        "  \t\tnotes on hotels",
        "  \t- [ ] Pack %%td:E%%", // after Book hotel and what's nested under it
        "- [ ] Other",
      ]);
      expect(added.map((a) => a.item.id)).toEqual(["F", "C", "D", "E"]);
      expect(added[1].line).toBe("  \t- [ ] Book flights %%td:C%%");
      expect(subtaskCount(state, "A")).toBe(4); // the read refreshed the counts
    });

    it("finds the end of the block nested under a line", () => {
      const lines = ["- [ ] A", "\t- [ ] B", "", "\t\tnotes", "", "- [ ] C", "\t- [ ] D", "- [ ] E"];
      expect([0, 1, 5, 6, 7].map((i) => blockEnd(lines, i))).toEqual([3, 3, 6, 6, 7]);
    });

    it("links imported lines, so they sync as existing tasks", async () => {
      add("A", "Plan trip today p1", { due: { date: "2030-02-01" }, priority: 4, labels: ["PhoneCall"] });
      add("B", "Book hotel", { parent_id: "A" });
      const open = await engine.openTasks();
      const { lines, items } = importLines(open[0], open, (id) => engine.isLinked(id), "", "\t");
      await engine.registerImport("Note.md", items.map((item, i) => ({ item, line: lines[i] })));
      expect(state.remote["A"]).toMatchObject({ projectId: "P2", priority: 4, labels: ["PhoneCall"], due: "2030-02-01" });
      expect(engine.isLinked("A")).toBe(true);

      vault.files.set("Note.md", `# Trip\n${lines.join("\n")}`);
      const calls = todoist.calls.length;
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(todoist.calls.length).toBe(calls + 1); // just the pull: nothing created or changed
      expect(vault.files.get("Note.md")).toBe(`# Trip\n${lines.join("\n")}`);
      expect(todoist.items.get("A")).toMatchObject({ content: "Plan trip today p1", priority: 4 });

      // Edits on either side sync as usual.
      vault.files.set("Note.md", vault.files.get("Note.md")!.replace("- [ ] Book hotel", "- [x] Book hotel"));
      await engine.pushFile("Note.md");
      expect(todoist.items.get("B")!.checked).toBe(true);
    });
  });

  describe("titles from Todoist", () => {
    it("keeps reference-like words in a title edited in Todoist", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      todoist.edit("T1", { content: "Call Bob today re p2 @home" });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob today re p2 @home %%td:T1%%");
      const calls = todoist.calls.length;
      await engine.pushFile("Note.md");
      expect(todoist.calls.length).toBe(calls); // nothing to send
      expect(todoist.items.get("T1")).toMatchObject({ content: "Call Bob today re p2 @home", priority: 1, due: null });
    });

    it("still reads references typed after such a title", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      todoist.edit("T1", { content: "Call Bob today" });
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob today and Sue p1 %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ content: "Call Bob today and Sue", priority: 4, due: null });
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob today and Sue %%td:T1%%");
    });

    it("treats an adopted line's words as its title", async () => {
      todoist.items.set("T7", { id: "T7", content: "Lunch friday", description: "", project_id: "inbox", checked: false, is_deleted: false, priority: 1, due: null, seq: ++todoist.seq });
      vault.files.set("Note.md", "- [ ] Lunch friday %%td:T7%%");
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(todoist.items.get("T7")).toMatchObject({ content: "Lunch friday", due: null });
      expect(vault.files.get("Note.md")).toBe("- [ ] Lunch friday %%td:T7%%");
    });
  });

  describe("due dates in words", () => {
    const D = FakeTodoist.WORDS_DATE;

    it("creates a task with the words for Todoist to parse, then writes the date to the line", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Send invoice next friday p2");
      await engine.pushFile("Note.md");
      expect(todoist.calls.at(-1)![0].args.due).toEqual({ string: "next friday", lang: "en" });
      expect(vault.files.get("Note.md")).toBe("- [ ] Send invoice %%td:T1%%");
      expect(engine.takePullRequest()).toBe(true);
      expect(engine.takePullRequest()).toBe(false); // once
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(`- [ ] Send invoice %%td:T1%% ⏳ ${D}`);
      expect(state.tasks.T1.base.due).toBe(D);
    });

    it("changes a synced task's date, and the words beat an edited ⏳", async () => {
      vault.files.set("Note.md", "- [ ] Pay rent ⏳ 2026-11-01");
      await engine.pushFile("Note.md");
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Pay rent every month %%td:T1%% ⏳ 2026-12-01");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toMatchObject({ date: D, is_recurring: true });
      expect(vault.files.get("Note.md")).toBe("- [ ] Pay rent %%td:T1%% ⏳ 2026-12-01");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(`- [ ] Pay rent %%td:T1%% ⏳ ${D}`);
      expect(state.remote.T1.recurring).toBe(true);
    });

    it("leaves the words on the line while it's being edited", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", "- [ ] Call Bob tomorrow %%td:T1%%");
      expect((await engine.pushFile("Note.md", { skipLine: 0 })).deferred).toBe(true);
      expect(todoist.items.get("T1")!.due).toBeNull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob tomorrow %%td:T1%%");
    });
  });

  describe("@label references", () => {
    beforeEach(() => engine.pull());

    it("creates a task with its labels, using Todoist's spelling, and strips them", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob @phonecall @[waiting for] ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ content: "Call Bob", labels: ["PhoneCall", "Waiting For"] });
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-10");
      expect(state.remote.T1.labels).toEqual(["PhoneCall", "Waiting For"]);
    });

    it("creates a missing label once, even when two lines name it", async () => {
      vault.files.set("Note.md", "- [ ] one @Errands\n- [ ] two @errands");
      await engine.pushFile("Note.md");
      expect(todoist.labels.filter((l) => l.name.toLowerCase() === "errands")).toHaveLength(1);
      expect(todoist.items.get("T2")!.labels).toEqual(["Errands"]);
      await engine.pull();
      expect(Object.values(state.labels).filter((l) => l.name === "Errands")).toHaveLength(1);
    });

    it("adds labels to a synced task without dropping the ones it has", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      todoist.edit("T1", { labels: ["PhoneCall"] });
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob @[Waiting For] %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.labels).toEqual(["PhoneCall", "Waiting For"]);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%%");
    });

    it("waits while the line is being edited, or until the task's labels are known", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", "- [ ] Call Bob @PhoneCall %%td:T1%%");
      expect((await engine.pushFile("Note.md", { skipLine: 0 })).deferred).toBe(true);
      delete state.remote.T1;
      expect((await engine.pushFile("Note.md")).deferred).toBe(true);
      expect(todoist.items.get("T1")!.labels).toEqual([]);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob @PhoneCall %%td:T1%%");
    });

    it("does not create labels on a device with creation disabled", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      settings.canCreate = false;
      vault.files.set("Note.md", "- [ ] Call Bob @Brand-new %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.labels.some((l) => l.name === "Brand-new")).toBe(false);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob @Brand-new %%td:T1%%");
    });
  });

  describe("due date picker", () => {
    beforeEach(async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Trip\n\t- [ ] Book train ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      await engine.pull();
    });

    it("sets a date, and the line's ⏳ follows", async () => {
      expect(await engine.changeDue("T2", { date: "2026-11-14" })).toBe(true);
      expect(todoist.items.get("T2")!.due).toMatchObject({ date: "2026-11-14" });
      expect(vault.files.get("Note.md")).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] Book train %%td:T2%% ⏳ 2026-11-14");
      expect(state.remote.T2.due).toBe("2026-11-14");
      const calls = todoist.calls.length;
      await engine.pushFile("Note.md");
      expect(todoist.calls.slice(calls).some((c) => c.length)).toBe(false); // nothing left to push
    });

    it("gives a task without a date one", async () => {
      await engine.changeDue("T1", { date: "2026-11-09" });
      expect(vault.files.get("Note.md")).toBe("- [ ] Trip %%td:T1%% ⏳ 2026-11-09\n\t- [ ] Book train %%td:T2%% ⏳ 2026-11-10");
    });

    it("sends words for Todoist to work out, including a repeat", async () => {
      await engine.changeDue("T2", { words: "every month" });
      expect(todoist.items.get("T2")!.due).toMatchObject({ string: "every month", is_recurring: true });
      expect(vault.files.get("Note.md")).toBe(`- [ ] Trip %%td:T1%%\n\t- [ ] Book train %%td:T2%% ⏳ ${FakeTodoist.WORDS_DATE}`);
      expect(state.remote.T2.recurring).toBe(true);
    });

    it("removes the date", async () => {
      await engine.changeDue("T2", null);
      expect(todoist.items.get("T2")!.due).toBeNull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] Book train %%td:T2%%");
    });

    it("keeps the time of day when it picks another date", async () => {
      todoist.edit("T2", { due: { date: "2026-11-10T14:30:00" } });
      await engine.pull();
      expect(state.remote.T2.dueTime).toBe("14:30:00");
      await engine.changeDue("T2", { date: "2026-11-14" });
      expect(todoist.items.get("T2")!.due).toEqual({ date: "2026-11-14T14:30:00" });
      expect(vault.files.get("Note.md")).toBe("- [ ] Trip %%td:T1%%\n\t- [ ] Book train %%td:T2%% ⏳ 2026-11-14");
    });
  });

  describe("due times", () => {
    const sync = async (line: string) => {
      vault.files.set("Note.md", line);
      await engine.pushFile("Note.md");
      await engine.pull();
    };

    it("keeps a time set in Todoist when the date changes on the line", async () => {
      await sync("- [ ] Call Bob ⏳ 2026-11-20");
      todoist.edit("T1", { due: { date: "2026-11-20T09:00:00" } });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-20"); // the time isn't written
      vault.files.set("Note.md", "- [ ] Call Bob %%td:T1%% ⏳ 2026-11-22");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-22T09:00:00" });
      // Removing the date removes the time with it; a new date has none.
      vault.files.set("Note.md", "- [ ] Call Bob %%td:T1%%");
      await engine.pushFile("Note.md");
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob %%td:T1%% ⏳ 2026-11-25");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-25" });
    });

    it("reads a time fixed to a timezone on its own day there, and keeps it", async () => {
      await sync("- [ ] Call Bob ⏳ 2026-11-20");
      // 9am in Melbourne (UTC+11) on the 20th is 22:00 UTC on the 19th.
      todoist.edit("T1", { due: { date: "2026-11-19T22:00:00Z", timezone: "Australia/Melbourne" } });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%% ⏳ 2026-11-20");
      expect(state.remote.T1).toMatchObject({ due: "2026-11-20", dueTime: "09:00:00", dueTimezone: "Australia/Melbourne" });
      vault.files.set("Note.md", "- [ ] Call Bob %%td:T1%% ⏳ 2026-11-22");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-21T22:00:00Z", timezone: "Australia/Melbourne" });
    });

    it("keeps Todoist's wording of a repeat with a time, and adds the time to a new rule", async () => {
      settings.tasksFields = true;
      await sync("- [ ] Review ⏳ 2026-11-13");
      todoist.edit("T1", { due: { date: "2026-11-13T14:00:00", string: "every Friday at 2pm", is_recurring: true } });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Review %%td:T1%% 🔁 every week on Friday ⏳ 2026-11-13");
      vault.files.set("Note.md", "- [ ] Review %%td:T1%% 🔁 every week on Friday ⏳ 2026-11-20");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toMatchObject({ date: "2026-11-20T14:00:00", string: "every Friday at 2pm" });
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Review %%td:T1%% 🔁 every week on Monday ⏳ 2026-11-23");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toMatchObject({ date: "2026-11-23T14:00:00", string: "every monday at 14:00" });
    });

    it("runs a full sync once, to learn every task's time", async () => {
      await sync("- [ ] Call Bob");
      expect(state.timesSynced).toBe(true);
      delete state.timesSynced;
      const calls = todoist.syncTokens.length;
      await engine.pull();
      expect(todoist.syncTokens.slice(calls)).toEqual(["*"]);
      await engine.pull();
      expect(todoist.syncTokens.slice(calls + 1)).not.toContain("*");
    });
  });

  describe("label picker", () => {
    beforeEach(async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Call Bob");
      await engine.pushFile("Note.md");
      todoist.edit("T1", { labels: ["PhoneCall"] });
      await engine.pull();
    });

    it("adds and removes labels, using Todoist's spelling", async () => {
      expect(await engine.changeLabels("T1", ["waiting for"], ["phonecall"])).toBe(true);
      expect(todoist.items.get("T1")!.labels).toEqual(["Waiting For"]);
      expect(state.remote.T1.labels).toEqual(["Waiting For"]);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob %%td:T1%%");
    });

    it("works from the task's labels as Todoist has them now", async () => {
      todoist.edit("T1", { labels: ["PhoneCall", "Waiting For"] }); // added in Todoist since the last pull
      await engine.changeLabels("T1", ["Errands"], ["PhoneCall"]);
      expect(todoist.items.get("T1")!.labels).toEqual(["Waiting For", "Errands"]);
    });

    it("creates a missing label once", async () => {
      await engine.changeLabels("T1", ["Errands", "errands"], []);
      expect(todoist.labels.filter((l) => l.name.toLowerCase() === "errands")).toHaveLength(1);
      expect(todoist.items.get("T1")!.labels).toEqual(["PhoneCall", "Errands"]);
      expect(Object.values(state.labels).some((l) => l.name === "Errands")).toBe(true); // listed before the next pull
    });

    it("sends nothing when nothing changes", async () => {
      const calls = todoist.calls.length;
      await engine.changeLabels("T1", ["phonecall"], ["Waiting For"]);
      expect(todoist.calls.slice(calls).some((c) => c.length)).toBe(false);
    });

    it("leaves a task deleted in Todoist alone", async () => {
      state.tasks.T1.orphaned = true;
      expect(await engine.changeLabels("T1", ["Errands"], [])).toBe(false);
      expect(todoist.items.get("T1")!.labels).toEqual(["PhoneCall"]);
    });
  });

  describe("Tasks plugin lines", () => {
    it("creates a task with a clean title and keeps Tasks' fields after the marker", async () => {
      vault.files.set("Note.md", "- [ ] Water plants 🔁 every week ⏫ 📅 2026-11-10 ⏳ 2026-11-08");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ content: "Water plants", due: { date: "2026-11-08" }, deadline: { date: "2026-11-10" } });
      expect(vault.files.get("Note.md")).toBe("- [ ] Water plants %%td:T1%% ⏫ 🔁 every week ⏳ 2026-11-08 📅 2026-11-10");
    });

    it("keeps a done date Tasks added, and a pull leaves it", async () => {
      vault.files.set("Note.md", "- [ ] Pay rent ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", "- [x] Pay rent %%td:T1%% ⏳ 2026-11-10 ✅ 2026-11-06");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ checked: true, content: "Pay rent" });
      todoist.edit("T1", { content: "Pay the rent" });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [x] Pay the rent %%td:T1%% ⏳ 2026-11-10 ✅ 2026-11-06");
    });

    it("leaves an in-progress task open and closes a cancelled one", async () => {
      vault.files.set("Note.md", "- [ ] Draft\n- [ ] Trip");
      await engine.pushFile("Note.md");
      vault.files.set("Note.md", "- [/] Draft %%td:T1%%\n- [-] Trip %%td:T2%%");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.checked).toBe(false);
      expect(todoist.items.get("T2")!.checked).toBe(true);
      todoist.edit("T2", { checked: false });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [/] Draft %%td:T1%%\n- [ ] Trip %%td:T2%%");
    });

    it("rewrites lines from earlier versions: the marker last, and the Todoist date as 📅", async () => {
      vault.files.set("Note.md", "- [ ] Call Bob\n- [ ] Pay rent\n- [ ] Plain");
      await engine.pushFile("Note.md");
      // A title from Todoist that reads as references, and a deadline set in Todoist.
      todoist.edit("T1", { content: "Call Bob today", due: { date: "2026-11-10" } });
      todoist.edit("T2", { due: { date: "2026-11-12" } });
      todoist.edit("T3", { deadline: { date: "2026-11-20" } });
      await engine.pull();
      // As written and synced before deadlines did: `📅` was the date, and the records have no deadline.
      for (const id of ["T1", "T2", "T3"]) delete state.tasks[id].base.deadline;
      vault.files.set("Note.md", "- [ ] Call Bob today 📅 2026-11-10 %%td:T1%%\n- [ ] Pay rent %%td:T2%% 📅 2026-11-12\n- [ ] Plain %%td:T3%%");
      vault.files.set("Other.md", "- [ ] Fix ⏫ %%td:T9%%\n- [ ] Plain %%td:T8%%");
      const calls = todoist.calls.length;
      expect(await engine.migrateVault({ path: "Other.md", line: 0 })).toBe(2);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob today %%td:T1%% ⏳ 2026-11-10\n- [ ] Pay rent %%td:T2%% ⏳ 2026-11-12\n- [ ] Plain %%td:T3%%");
      expect(vault.files.get("Other.md")).toBe("- [ ] Fix ⏫ %%td:T9%%\n- [ ] Plain %%td:T8%%"); // being edited
      expect([state.relaidOut, state.datesMigrated]).toEqual([true, true]);
      expect(["T1", "T2", "T3"].map((id) => state.tasks[id].base.deadline)).toEqual([null, null, null]);
      // A full sync then brings deadlines set in Todoist to the lines, and sends nothing.
      await engine.pull();
      expect(state.deadlinesSynced).toBe(true);
      expect(vault.files.get("Note.md")!.split("\n")[2]).toBe("- [ ] Plain %%td:T3%% 📅 2026-11-20");
      // The line being edited moves with its next push.
      await engine.pushFile("Other.md");
      expect(vault.files.get("Other.md")).toBe("- [ ] Fix %%td:T9%% ⏫\n- [ ] Plain %%td:T8%%");
      expect(todoist.calls.slice(calls).flat().some((c) => c.type === "item_update" && ["T1", "T2", "T3"].includes(c.args.id as string))).toBe(false);
    });

    it("reads a line last synced before deadlines as having its date in 📅", async () => {
      vault.files.set("Note.md", "- [ ] Call\n- [ ] Pay");
      await engine.pushFile("Note.md");
      for (const id of ["T1", "T2"]) state.tasks[id].base = { ...state.tasks[id].base, due: "2026-11-10" };
      for (const id of ["T1", "T2"]) delete state.tasks[id].base.deadline;
      todoist.edit("T1", { due: { date: "2026-11-10" } });
      todoist.edit("T2", { due: { date: "2026-11-10" } });
      await engine.pull();
      // Changed in Todoist: the line is rewritten with the date as `⏳`.
      vault.files.set("Note.md", "- [ ] Call %%td:T1%% 📅 2026-11-10\n- [ ] Pay %%td:T2%% 📅 2026-11-10");
      todoist.edit("T1", { due: { date: "2026-11-11" } });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Call %%td:T1%% ⏳ 2026-11-11\n- [ ] Pay %%td:T2%% 📅 2026-11-10");
      expect(state.tasks.T1.base.deadline).toBe(null);
      // Edited here, on the line being edited: still the date.
      vault.files.set("Note.md", "- [ ] Call %%td:T1%% ⏳ 2026-11-11\n- [ ] Pay %%td:T2%% 📅 2026-11-15");
      await engine.pushFile("Note.md", { skipLine: 1 });
      expect(todoist.items.get("T2")).toMatchObject({ due: { date: "2026-11-15" }, deadline: null });
      expect(todoist.items.get("T1")!.deadline).toBe(null);
    });

    it("syncs the deadline both ways as 📅", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Report ⏳ 2026-11-12 📅 2026-11-14");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ due: { date: "2026-11-12" }, deadline: { date: "2026-11-14" } });
      expect(state.remote.T1.deadline).toBe("2026-11-14");
      vault.files.set("Note.md", "- [ ] Report %%td:T1%% ⏳ 2026-11-12 📅 2026-11-15");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.deadline).toEqual({ date: "2026-11-15" });
      todoist.edit("T1", { deadline: null });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Report %%td:T1%% ⏳ 2026-11-12");
      expect(state.remote.T1.deadline).toBe(null);
    });
  });

  describe("copies of a task", () => {
    /** Home.md has the task as T1; Daily.md gets a copy of its line. */
    const withCopy = async (home = "- [ ] Plant bulbs", copy = "- [ ] Plant bulbs %%td:T1%%") => {
      vault.files.set("Home.md", home);
      await engine.pushFile("Home.md");
      await engine.pull();
      vault.files.set("Daily.md", copy);
      await engine.pushFile("Daily.md");
    };

    it("syncs a copy in another note both ways, keeping the note it came from as home", async () => {
      await withCopy();
      expect(state.tasks.T1).toMatchObject({ path: "Home.md", copies: ["Daily.md"] });

      // Edited in the copy: Todoist and the home line follow.
      vault.files.set("Daily.md", "- [ ] Plant tulips %%td:T1%% ⏳ 2026-11-14");
      await engine.pushFile("Daily.md");
      expect(todoist.items.get("T1")).toMatchObject({ content: "Plant tulips", due: { date: "2026-11-14" } });
      expect(vault.files.get("Home.md")).toBe("- [ ] Plant tulips %%td:T1%% ⏳ 2026-11-14");

      // Changed in Todoist: every copy follows.
      todoist.edit("T1", { checked: true, due: { date: "2026-11-15" } });
      await engine.pull();
      expect(vault.files.get("Home.md")).toBe("- [x] Plant tulips %%td:T1%% ⏳ 2026-11-15");
      expect(vault.files.get("Daily.md")).toBe("- [x] Plant tulips %%td:T1%% ⏳ 2026-11-15");
    });

    it("syncs copies within one note", async () => {
      vault.files.set("Note.md", "- [ ] A\n- [ ] B");
      await engine.pushFile("Note.md");
      await engine.pull();
      vault.files.set("Note.md", "- [ ] A %%td:T1%%\n- [ ] B %%td:T2%%\n- [x] A %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.checked).toBe(true);
      expect(vault.files.get("Note.md")).toBe("- [x] A %%td:T1%%\n- [ ] B %%td:T2%%\n- [x] A %%td:T1%%");
      todoist.edit("T1", { content: "A2" });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [x] A2 %%td:T1%%\n- [ ] B %%td:T2%%\n- [x] A2 %%td:T1%%");
    });

    it("makes a copy the home when the home line goes, and unlinks only when the last line goes", async () => {
      await withCopy();
      vault.files.set("Home.md", "");
      await engine.pushFile("Home.md");
      expect(state.tasks.T1.path).toBe("Daily.md");
      expect(state.tasks.T1.copies).toBeUndefined();
      expect(todoist.items.get("T1")!.checked).toBe(false);
      vault.files.set("Daily.md", "");
      await engine.pushFile("Daily.md");
      expect(state.tasks.T1).toBeUndefined();
      expect(todoist.items.get("T1")!.checked).toBe(false);
    });

    it("drops a copy whose line goes, and moves home with a line moved to another note", async () => {
      await withCopy();
      vault.files.set("Daily.md", "");
      await engine.pushFile("Daily.md");
      expect(state.tasks.T1.copies).toBeUndefined();
      // Cut from Home.md and pasted into Other.md, which syncs first.
      vault.files.set("Home.md", "");
      vault.files.set("Other.md", "- [ ] Plant bulbs %%td:T1%%");
      await engine.pushFile("Other.md");
      expect(state.tasks.T1).toMatchObject({ path: "Other.md" });
      await engine.pushFile("Home.md");
      expect(state.tasks.T1).toMatchObject({ path: "Other.md" });
    });

    it("takes the task's nesting from its home note only", async () => {
      vault.files.set("Home.md", "- [ ] Parent\n\t- [ ] Child");
      await engine.pushFile("Home.md");
      await engine.pull();
      expect(todoist.items.get("T2")!.parent_id).toBe("T1");
      const from = todoist.calls.length;
      // A copy at the top level, and one nested under another task: neither moves it.
      vault.files.set("Daily.md", "- [ ] Child %%td:T2%%\n- [ ] Other\n\t- [ ] Parent %%td:T1%%");
      await engine.pushFile("Daily.md");
      expect(todoist.calls.slice(from).flat().filter((c) => c.type === "item_move")).toEqual([]);
      expect(todoist.items.get("T2")!.parent_id).toBe("T1");
      expect(todoist.items.get("T1")!.parent_id ?? null).toBe(null);
    });

    it("links copies found when a device starts without sync state", async () => {
      vault.files.set("Home.md", "- [ ] A %%td:X1%%");
      vault.files.set("Daily.md", "- [ ] A %%td:X1%%");
      expect(await engine.linkExisting()).toBe(1);
      expect(state.tasks.X1).toMatchObject({ path: "Home.md", copies: ["Daily.md"] });
    });
  });

  describe("Tasks' global filter", () => {
    afterEach(() => setTasksGlobalFilter(null));

    it("keeps the filter out of the Todoist title and on the line", async () => {
      setTasksGlobalFilter("#task");
      vault.files.set("Note.md", "- [ ] #task Buy milk");
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(todoist.items.get("T1")!.content).toBe("Buy milk");
      expect(vault.files.get("Note.md")).toBe("- [ ] #task Buy milk %%td:T1%%");
      todoist.edit("T1", { content: "Buy bread" });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] #task Buy bread %%td:T1%%");
    });

    it("drops the filter from the title of a task synced before it was known", async () => {
      vault.files.set("Note.md", "- [ ] #task Buy milk");
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(todoist.items.get("T1")!.content).toBe("#task Buy milk");
      setTasksGlobalFilter("#task");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.content).toBe("Buy milk");
      expect(vault.files.get("Note.md")).toBe("- [ ] #task Buy milk %%td:T1%%");
    });

    it("with only, makes tasks from lines with the filter alone, and keeps syncing linked ones", async () => {
      vault.files.set("Note.md", "- [ ] Linked");
      await engine.pushFile("Note.md");
      await engine.pull();
      setTasksGlobalFilter("#task", true);
      vault.files.set("Note.md", "- [x] Linked %%td:T1%%\n- [ ] Just a checkbox\n- [ ] #task A task");
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(todoist.items.get("T1")!.checked).toBe(true);
      expect([...todoist.items.values()].map((i) => i.content).sort()).toEqual(["A task", "Linked"]);
      expect(vault.files.get("Note.md")).toBe("- [x] Linked %%td:T1%%\n- [ ] Just a checkbox\n- [ ] #task A task %%td:T2%%");
    });

    it("puts the filter on imported lines", () => {
      setTasksGlobalFilter("#task");
      const item = { id: "X1", content: "Call Bob", description: "", project_id: "inbox", checked: false, is_deleted: false, priority: 1, due: null } as TodoistItem;
      expect(taskLine(item, "")).toBe("- [ ] #task Call Bob %%td:X1%%");
    });
  });

  describe("Tasks plugin statuses", () => {
    afterEach(() => setTasksStatuses(null));

    it("completes the Todoist task for Tasks' custom done and cancelled statuses", async () => {
      setTasksStatuses([
        { symbol: "d", type: "DONE" },
        { symbol: "c", type: "CANCELLED" },
        { symbol: "~", type: "NON_TASK" },
        { symbol: "!", type: "TODO" },
      ]);
      settings.tasksFields = true;
      vault.files.set("Note.md", "- [ ] A\n- [ ] B\n- [ ] C\n- [!] D\n- [~] Not a task");
      await engine.pushFile("Note.md");
      expect(todoist.items.size).toBe(4); // NON_TASK isn't sent
      await engine.pull();
      vault.files.set("Note.md", "- [d] A %%td:T1%%\n- [c] B %%td:T2%%\n- [~] C %%td:T3%%\n- [!] D %%td:T4%%\n- [~] Not a task");
      await engine.pushFile("Note.md");
      expect(["T1", "T2", "T3", "T4"].map((id) => todoist.items.get(id)!.checked)).toEqual([true, true, false, false]);
      // Done gets a done date; cancelled a cancelled date.
      expect(vault.files.get("Note.md")).toBe(
        `- [d] A %%td:T1%% ✅ ${isoDate(new Date())}\n- [c] B %%td:T2%% ❌ ${isoDate(new Date())}\n- [~] C %%td:T3%%\n- [!] D %%td:T4%%\n- [~] Not a task`,
      );
    });
  });

  describe("🏁 delete", () => {
    const expire = (id: string) => (state.tasks[id].gone = Date.now() - GONE_GRACE_MS);

    beforeEach(async () => {
      vault.files.set("Note.md", "- [ ] Once 🏁 delete\n- [ ] Plain");
      await engine.pushFile("Note.md");
      await engine.pull();
    });

    it("completes the Todoist task once Tasks has deleted its line", async () => {
      vault.files.set("Note.md", "- [ ] Plain %%td:T2%%");
      await engine.pushFile("Note.md");
      expect(state.tasks.T1.gone).toBeDefined();
      await engine.pull(); // not yet: it may turn up in another note
      expect(todoist.items.get("T1")!.checked).toBe(false);
      expire("T1");
      await engine.pull();
      expect(todoist.items.get("T1")!.checked).toBe(true);
      expect(state.tasks.T1).toBeUndefined();
    });

    it("leaves a line moved to another note linked there", async () => {
      vault.files.set("Note.md", "- [ ] Plain %%td:T2%%");
      await engine.pushFile("Note.md");
      vault.files.set("Other.md", "- [ ] Once %%td:T1%% 🏁 delete");
      expire("T1");
      await engine.pull();
      expect(todoist.items.get("T1")!.checked).toBe(false);
      expect(state.tasks.T1).toMatchObject({ path: "Other.md" });
      expect(state.tasks.T1.gone).toBeUndefined();
    });

    it("comes back linked if the line is restored, and a line without 🏁 delete is just unlinked", async () => {
      vault.files.set("Note.md", "");
      await engine.pushFile("Note.md");
      expect(state.tasks.T2).toBeUndefined();
      vault.files.set("Note.md", "- [ ] Once %%td:T1%% 🏁 delete");
      await engine.pushFile("Note.md");
      expect(state.tasks.T1.gone).toBeUndefined();
      await engine.pull();
      expect(todoist.items.get("T1")!.checked).toBe(false);
      expect(todoist.items.get("T2")!.checked).toBe(false);
    });
  });

  describe("dates from note names", () => {
    beforeEach(() => {
      settings.fileDate = (p) => fileDate(p, { enabled: true, folders: ["Daily"], format: "" });
    });

    it("sends a daily note's date as the date of its tasks without one, leaving the line as it is", async () => {
      vault.files.set("Daily/2026-11-09.md", "- [ ] Call Bob");
      vault.files.set("Work/2026-11-09.md", "- [ ] Not a daily note");
      await engine.pushFile("Daily/2026-11-09.md");
      await engine.pushFile("Work/2026-11-09.md");
      await engine.pull();
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-09" });
      expect(todoist.items.get("T2")!.due).toBeNull();
      expect(vault.files.get("Daily/2026-11-09.md")).toBe("- [ ] Call Bob %%td:T1%%");

      // Other changes leave it unwritten; a new date in Todoist is written.
      todoist.edit("T1", { content: "Call Bob back" });
      await engine.pull();
      expect(vault.files.get("Daily/2026-11-09.md")).toBe("- [ ] Call Bob back %%td:T1%%");
      todoist.edit("T1", { due: { date: "2026-11-12" } });
      await engine.pull();
      expect(vault.files.get("Daily/2026-11-09.md")).toBe("- [ ] Call Bob back %%td:T1%% ⏳ 2026-11-12");
    });

    it("uses the line's own date over the note's", async () => {
      vault.files.set("Daily/2026-11-09.md", "- [ ] A ⏳ 2026-11-15\n- [ ] B 📅 2026-11-20");
      await engine.pushFile("Daily/2026-11-09.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-15" });
      expect(todoist.items.get("T2")!.due).toBeNull();
      expect(todoist.items.get("T2")!.deadline).toEqual({ date: "2026-11-20" });
    });
  });

  describe("completions of repeating tasks in Todoist", () => {
    const today = isoDate(new Date());
    const repeating = async (content = "- [ ] Water 🔁 every week ⏳ 2026-11-10") => {
      settings.tasksFields = true;
      vault.files.set("Note.md", content);
      await engine.pushFile("Note.md");
      await engine.pull();
    };

    it("leaves a ticked line for each, newest nearest, as Tasks does", async () => {
      await repeating();
      todoist.completeRecurring("T1");
      todoist.completeRecurring("T1");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(
        [
          "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-24",
          `- [x] Water 🔁 every week ⏳ 2026-11-17 ✅ ${today}`,
          `- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ ${today}`,
        ].join("\n"),
      );
      // Nothing more at the next pull.
      await engine.pull();
      expect(vault.files.get("Note.md")!.split("\n")).toHaveLength(3);
    });

    it("looks again at the next pull for a completion not yet in the activity log", async () => {
      await repeating();
      todoist.completeRecurring("T1");
      const logged = todoist.events.splice(0); // Todoist hasn't logged it yet
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17");
      expect(state.tasks.T1.historyDue).toMatchObject({ from: "2026-11-10", to: "2026-11-17" });
      todoist.events.push(...logged);
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(`- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17
- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ ${today}`);
      expect(state.tasks.T1.historyDue).toBeUndefined();
    });

    it("puts them above the task when Tasks puts the next occurrence below", async () => {
      settings.historyAbove = true;
      await repeating();
      todoist.completeRecurring("T1");
      todoist.completeRecurring("T1");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(
        [
          `- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ ${today}`,
          `- [x] Water 🔁 every week ⏳ 2026-11-17 ✅ ${today}`,
          "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-24",
        ].join("\n"),
      );
    });

    it("keeps them below the task's subtasks", async () => {
      await repeating("- [ ] Water 🔁 every week ⏳ 2026-11-10\n\t- [ ] Fill can\n- [ ] Next");
      todoist.completeRecurring("T1");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(
        `- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17\n\t- [ ] Fill can %%td:T2%%\n- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ ${today}\n- [ ] Next %%td:T3%%`,
      );
    });

    it("leaves none for a date moved in Todoist, a date moved on the line, or with Tasks fields off", async () => {
      await repeating();
      todoist.edit("T1", { due: { date: "2026-11-12", string: "every week", is_recurring: true } });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-12");

      vault.files.set("Note.md", "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-19");
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-19");

      settings.tasksFields = false;
      todoist.completeRecurring("T1");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-26");
    });
  });

  describe("repeats", () => {
    const sent = (from: number) => todoist.calls.slice(from).flat();

    it("syncs a line's 🔁 with the Todoist task's repeat, both ways", async () => {
      settings.tasksFields = true;
      vault.files.set("Note.md", "- [ ] Water 🔁 every week ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-10", string: "every week", is_recurring: true });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-10");

      todoist.edit("T1", { due: { date: "2026-11-12", string: "every! 2 weeks", is_recurring: true } });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Water %%td:T1%% 🔁 every 2 weeks when done ⏳ 2026-11-12");

      // Changed on the line: the new rule, from the line's date.
      vault.files.set("Note.md", "- [ ] Water %%td:T1%% 🔁 every mon ⏳ 2026-11-16");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-16", string: "every monday", is_recurring: true });

      // Removed from the line: no longer repeats.
      vault.files.set("Note.md", "- [ ] Water %%td:T1%% ⏳ 2026-11-16");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-16" });
    });

    it("writes Todoist's repeats to their lines once turned on, leaving ones Tasks wouldn't read", async () => {
      vault.files.set("Note.md", "- [ ] A\n- [ ] B");
      await engine.pushFile("Note.md");
      todoist.edit("T1", { due: { date: "2026-11-10", string: "every 15th", is_recurring: true } });
      todoist.edit("T2", { due: { date: "2026-11-20", string: "every first workday", is_recurring: true } });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] A %%td:T1%% ⏳ 2026-11-10\n- [ ] B %%td:T2%% ⏳ 2026-11-20");
      settings.tasksFields = true;
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] A %%td:T1%% 🔁 every month on the 15th ⏳ 2026-11-10\n- [ ] B %%td:T2%% ⏳ 2026-11-20");

      // A new date for the one the line can't show keeps its repeat.
      const from = todoist.calls.length;
      vault.files.set("Note.md", "- [ ] A %%td:T1%% 🔁 every month on the 15th ⏳ 2026-11-10\n- [ ] B %%td:T2%% ⏳ 2026-12-18");
      await engine.pushFile("Note.md");
      expect(sent(from).find((c) => c.type === "item_update")!.args.due).toEqual({ date: "2026-12-18", string: "every first workday" });
    });

    it("keeps a Todoist repeat when the line's date changes, with Tasks fields off", async () => {
      vault.files.set("Note.md", "- [ ] A");
      await engine.pushFile("Note.md");
      todoist.edit("T1", { due: { date: "2026-11-10", string: "every week", is_recurring: true } });
      await engine.pull();
      vault.files.set("Note.md", "- [ ] A %%td:T1%% 🔁 every week ⏳ 2026-11-11");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toEqual({ date: "2026-11-11", string: "every week", is_recurring: true });
    });

    it("completes one occurrence when Tasks ticks a repeating task, keeping its done copy as history", async () => {
      settings.tasksFields = true;
      vault.files.set("Note.md", "- [ ] Water 🔁 every week ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      await engine.pull();
      // What Tasks writes: the next occurrence above, the ticked one below, both with the marker.
      vault.files.set(
        "Note.md",
        "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17\n- [x] Water %%td:T1%% 🔁 every week ⏳ 2026-11-10 ✅ 2026-11-10",
      );
      const from = todoist.calls.length;
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe(
        "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17\n- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ 2026-11-10",
      );
      expect(sent(from).map((c) => c.type)).toEqual(["item_update_date_complete"]);
      expect(todoist.items.get("T1")).toMatchObject({ checked: false, due: { date: "2026-11-17", string: "every week", is_recurring: true } });
      expect(todoist.completions.get("T1")).toBe(1);

      // Settled: nothing more to send, and the pull leaves both lines alone.
      const after = todoist.calls.length;
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(sent(after).filter((c) => c.type.startsWith("item_"))).toEqual([]);
      expect(vault.files.get("Note.md")).toBe(
        "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17\n- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ 2026-11-10",
      );
    });

    it("completes the occurrence of a Todoist repeat ticked with Tasks, with Tasks fields off", async () => {
      vault.files.set("Note.md", "- [ ] Water");
      await engine.pushFile("Note.md");
      todoist.edit("T1", { due: { date: "2026-11-10", string: "every week", is_recurring: true } });
      await engine.pull();
      vault.files.set("Note.md", "- [x] Water %%td:T1%% 🔁 every week ⏳ 2026-11-10\n- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17");
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe("- [x] Water 🔁 every week ⏳ 2026-11-10\n- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17");
      expect(todoist.items.get("T1")).toMatchObject({ checked: false, due: { date: "2026-11-17", string: "every week" } });
      expect(todoist.completions.get("T1")).toBe(1);
    });

    it("moves a repeat ticked in Todoist, or ticked here without Tasks, to its next date", async () => {
      settings.tasksFields = true;
      vault.files.set("Note.md", "- [ ] Water 🔁 every week ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      await engine.pull();
      vault.files.set("Note.md", "- [x] Water %%td:T1%% 🔁 every week ⏳ 2026-11-10");
      await engine.pushFile("Note.md");
      await engine.pull();
      // Kept as a ticked line, as Tasks would have (see "completions of repeating tasks in Todoist").
      expect(vault.files.get("Note.md")).toBe(`- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17
- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ ${isoDate(new Date())}`);
      expect(todoist.completions.get("T1")).toBe(1);
    });

    it("updates the home line when Tasks ticks a repeating task in a copy", async () => {
      settings.tasksFields = true;
      vault.files.set("Home.md", "- [ ] Water 🔁 every week ⏳ 2026-11-10");
      await engine.pushFile("Home.md");
      await engine.pull();
      vault.files.set("Daily.md", "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-10");
      await engine.pushFile("Daily.md");
      vault.files.set("Daily.md", "- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17\n- [x] Water %%td:T1%% 🔁 every week ⏳ 2026-11-10 ✅ 2026-11-10");
      await engine.pushFile("Daily.md");
      expect(todoist.completions.get("T1")).toBe(1);
      expect(vault.files.get("Daily.md")).toBe("- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17\n- [x] Water 🔁 every week ⏳ 2026-11-10 ✅ 2026-11-10");
      expect(vault.files.get("Home.md")).toBe("- [ ] Water %%td:T1%% 🔁 every week ⏳ 2026-11-17");
    });

    it("imports a Todoist repeat as 🔁", () => {
      const item = { id: "R", content: "Water", description: "", project_id: "inbox", checked: false, is_deleted: false, priority: 1,
        due: { date: "2026-11-10", string: "every mon", is_recurring: true } } as TodoistItem;
      expect(importLines(item, [], () => false, "", "\t", false, true).lines).toEqual(["- [ ] Water %%td:R%% 🔁 every week on Monday ⏳ 2026-11-10"]);
    });
  });

  describe("writing Tasks plugin fields", () => {
    const today = () => isoDate(new Date());

    it("writes Todoist priorities once turned on, and a Tasks priority on a line sets Todoist's", async () => {
      vault.files.set("Note.md", "- [ ] A\n- [ ] B ⏫");
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(todoist.items.get("T2")!.priority).toBe(1); // off: the emoji is only kept
      todoist.edit("T1", { priority: 4 });
      settings.tasksFields = true;
      await engine.pull(); // a full sync, which reaches every task
      expect(vault.files.get("Note.md")).toBe("- [ ] A %%td:T1%% 🔺\n- [ ] B %%td:T2%% ⏫");
      expect(todoist.items.get("T2")!.priority).toBe(3);

      vault.files.set("Note.md", "- [ ] A %%td:T1%% 🔼\n- [ ] B %%td:T2%% ⏫");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.priority).toBe(2);
      expect(state.remote.T1.priority).toBe(2); // the chip follows straight away

      todoist.edit("T1", { priority: 1 });
      todoist.edit("T2", { priority: 1 });
      vault.files.set("Note.md", "- [ ] A %%td:T1%% 🔼\n- [ ] B %%td:T2%% 🔽");
      await engine.pull();
      // p4 is Tasks' normal priority, written as nothing; 🔽 is p4 too, so it stays.
      expect(vault.files.get("Note.md")).toBe("- [ ] A %%td:T1%%\n- [ ] B %%td:T2%% 🔽");
    });

    it("turns p1–p4 into a Tasks priority, on a new task and from the chip", async () => {
      settings.tasksFields = true;
      vault.files.set("Note.md", "- [ ] Call p2");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.priority).toBe(3);
      expect(vault.files.get("Note.md")).toBe("- [ ] Call %%td:T1%% ⏫");
      vault.files.set("Note.md", withRef(vault.files.get("Note.md")!, "p1"));
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe("- [ ] Call %%td:T1%% 🔺");
      expect(todoist.items.get("T1")!.priority).toBe(4);
      vault.files.set("Note.md", withRef(vault.files.get("Note.md")!, "p4"));
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe("- [ ] Call %%td:T1%%");
      expect(todoist.items.get("T1")!.priority).toBe(1);
    });

    it("adds a ✅ date when a task is completed, in Todoist or here, and removes it when unticked", async () => {
      settings.tasksFields = true;
      vault.files.set("Note.md", "- [ ] Pay\n- [ ] Skip");
      await engine.pushFile("Note.md");
      await engine.pull();
      const done = "2026-11-05T10:00:00Z";
      todoist.edit("T1", { checked: true, completed_at: done });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(`- [x] Pay %%td:T1%% ✅ ${isoDate(new Date(done))}\n- [ ] Skip %%td:T2%%`);
      todoist.edit("T1", { checked: false, completed_at: null });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Pay %%td:T1%%\n- [ ] Skip %%td:T2%%");

      // Ticked here: dated today. Cancelled: a cancelled date, not a done date.
      vault.files.set("Note.md", "- [x] Pay %%td:T1%%\n- [-] Skip %%td:T2%%");
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe(`- [x] Pay %%td:T1%% ✅ ${today()}\n- [-] Skip %%td:T2%% ❌ ${today()}`);
      expect(todoist.items.get("T1")!.checked).toBe(true);
      // A task already completed when last synced isn't dated afresh.
      vault.files.set("Note.md", "- [x] Pay %%td:T1%%\n- [-] Skip %%td:T2%%");
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe("- [x] Pay %%td:T1%%\n- [-] Skip %%td:T2%%");
      // Unticked here: the date goes.
      vault.files.set("Note.md", `- [ ] Pay %%td:T1%% ✅ ${today()}\n- [-] Skip %%td:T2%%`);
      await engine.pushFile("Note.md");
      expect(vault.files.get("Note.md")).toBe("- [ ] Pay %%td:T1%%\n- [-] Skip %%td:T2%%");
      expect(todoist.items.get("T1")!.checked).toBe(false);
    });

    describe("created and cancelled dates", () => {
      afterEach(() => setTasksDates(null));

      it("adds ❌ to a line cancelled here and removes it when Todoist reopens the task", async () => {
        settings.tasksFields = true;
        vault.files.set("Note.md", "- [ ] Skip");
        await engine.pushFile("Note.md");
        await engine.pull();
        vault.files.set("Note.md", "- [-] Skip %%td:T1%%");
        await engine.pushFile("Note.md");
        expect(vault.files.get("Note.md")).toBe(`- [-] Skip %%td:T1%% ❌ ${today()}`);
        expect(todoist.items.get("T1")!.checked).toBe(true);
        todoist.edit("T1", { checked: false, completed_at: null });
        await engine.pull();
        expect(vault.files.get("Note.md")).toBe("- [ ] Skip %%td:T1%%");
      });

      it("leaves ❌ off when Tasks doesn't add cancelled dates", async () => {
        settings.tasksFields = true;
        setTasksDates({ cancelled: false });
        vault.files.set("Note.md", "- [ ] Skip");
        await engine.pushFile("Note.md");
        await engine.pull();
        vault.files.set("Note.md", "- [-] Skip %%td:T1%%");
        await engine.pushFile("Note.md");
        expect(vault.files.get("Note.md")).toBe("- [-] Skip %%td:T1%%");
      });

      it("adds ➕ to new tasks only when Tasks adds created dates", async () => {
        settings.tasksFields = true;
        vault.files.set("Note.md", "- [ ] A");
        await engine.pushFile("Note.md");
        expect(vault.files.get("Note.md")).toBe("- [ ] A %%td:T1%%");
        setTasksDates({ created: true });
        vault.files.set("Note.md", "- [ ] A %%td:T1%%\n- [ ] B\n- [ ] C ➕ 2026-01-02");
        await engine.pushFile("Note.md");
        expect(vault.files.get("Note.md")).toBe(`- [ ] A %%td:T1%%\n- [ ] B %%td:T2%% ➕ ${today()}\n- [ ] C %%td:T3%% ➕ 2026-01-02`);
      });

      it("gives imported tasks the date they were added in Todoist as ➕", () => {
        const item = { id: "X1", content: "Call Bob", description: "", project_id: "inbox", checked: false, is_deleted: false, priority: 1, due: null, added_at: "2026-10-01T12:00:00Z" } as TodoistItem;
        expect(taskLine(item, "", true)).toBe("- [ ] Call Bob %%td:X1%%");
        setTasksDates({ created: true });
        expect(taskLine(item, "", true)).toBe(`- [ ] Call Bob %%td:X1%% ➕ ${isoDate(new Date(item.added_at!))}`);
      });
    });

    it("writes nothing while turned off", async () => {
      vault.files.set("Note.md", "- [ ] Pay p1");
      await engine.pushFile("Note.md");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [ ] Pay %%td:T1%%");
      todoist.edit("T1", { checked: true, completed_at: "2026-11-05T10:00:00Z" });
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe("- [x] Pay %%td:T1%%");
    });
  });

  it("does not create tasks on a device with creation disabled", async () => {
    settings.canCreate = false;
    vault.files.set("Note.md", "- [ ] phone task");
    await engine.pushFile("Note.md");
    expect(todoist.items.size).toBe(0);
    expect(vault.files.get("Note.md")).toBe("- [ ] phone task");
  });

  it("fetches details for a task created on another device, once", async () => {
    // The other device created T1 in Work; this device's pulls are already past it.
    vault.files.set("Phone.md", "- [ ] typed on the phone");
    const phone = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, { ...emptyState(), backfillDone: true }, () => settings, async () => {});
    vault.fm.set("Phone.md", { todoist_project: "Work" });
    await phone.pull();
    await phone.pushFile("Phone.md");
    expect(todoist.items.get("T1")!.project_id).toBe("P2");
    await engine.pull();
    expect(state.remote.T1).toBeUndefined(); // not tracked here yet, so skipped
    // Its marker syncs across, and this device adopts it.
    await engine.pushFile("Phone.md");
    expect(engine.missingDetails()).toEqual(["T1"]);
    await engine.pull();
    expect(state.remote.T1?.projectId).toBe("P2");
    expect(engine.missingDetails()).toEqual([]);
  });

  it("on a device with no sync state, links the markers already in the vault and fetches them", async () => {
    vault.files.set("Note.md", "- [ ] Call Bob");
    await engine.pushFile("Note.md");
    todoist.edit("T1", { content: "Call Bob soon", project_id: "P2" });
    vault.files.set("Templates/T.md", "- [ ] template %%td:T1%%");
    // A second device, starting empty.
    const fresh = { ...emptyState(), backfillDone: true };
    const other = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, fresh, () => settings, async () => {});
    expect(await other.linkExisting()).toBe(1); // excluded folders are skipped
    expect(fresh.tasks.T1).toEqual({ path: "Note.md", base: { text: "Call Bob", checked: false, due: null } });
    await other.pull();
    expect(fresh.remote.T1?.projectId).toBe("P2");
    expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob soon %%td:T1%%"); // Todoist's edit merged in
  });

  it("knows a task it just created without fetching it", async () => {
    await engine.pull();
    vault.files.set("Note.md", "- [ ] Call Bob #[Work] ⏳ 2026-11-10");
    await engine.pushFile("Note.md");
    expect(state.remote.T1).toMatchObject({ projectId: "P2", due: "2026-11-10", checked: false });
    expect(engine.missingDetails()).toEqual([]);
  });

  it("does not keep full-syncing for a task Todoist no longer returns", async () => {
    vault.files.set("Note.md", "- [ ] gone %%td:T99%%");
    await engine.pushFile("Note.md");
    await engine.pull();
    const before = todoist.calls.length;
    expect(engine.missingDetails()).toEqual([]);
    await engine.pull();
    expect(todoist.calls.length).toBe(before + 1);
  });

  it("with noCreate, updates existing tasks but creates none (a change synced in from elsewhere)", async () => {
    vault.files.set("Note.md", "- [ ] Call Bob");
    await engine.pushFile("Note.md");
    vault.files.set("Note.md", "- [ ] Call Bob soon %%td:T1%%\n- [ ] typed on the phone");
    await engine.pushFile("Note.md", { noCreate: true });
    expect(todoist.items.size).toBe(1);
    expect(todoist.items.get("T1")!.content).toBe("Call Bob soon");
    expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob soon %%td:T1%%\n- [ ] typed on the phone");
  });

  it("counts backfill candidates per folder", async () => {
    vault.files.set("A.md", "- [ ] a\n- [x] done");
    vault.files.set("Projects/X.md", "- [ ] b\n- [ ] c %%td:T9%%\n- [ ] d");
    vault.files.set("Templates/T.md", "- [ ] t");
    expect(await engine.countBackfill()).toEqual({ "/": 1, Projects: 2 });
  });
});
