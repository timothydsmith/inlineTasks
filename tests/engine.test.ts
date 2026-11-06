import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine, type EngineSettings, type VaultAdapter } from "../src/sync/engine";
import { importLines } from "../src/sync/importTask";
import { emptyState, type SyncState } from "../src/sync/state";
import { TodoistClient, type Command, type HttpRequest, type TodoistItem } from "../src/todoist/client";

/** In-memory Todoist that understands the handful of sync commands we send. */
class FakeTodoist {
  items = new Map<string, TodoistItem & { seq: number }>();
  seenUuids = new Set<string>();
  seq = 0;
  nextId = 1;
  calls: Command[][] = [];
  projects: { id: string; name: string; seq: number; inbox_project?: boolean; is_archived?: boolean; is_deleted?: boolean }[] = [
    { id: "inbox", name: "Inbox", inbox_project: true, seq: 0 },
    { id: "P2", name: "Work", seq: 0 },
    { id: "PA", name: "Old", is_archived: true, seq: 0 },
  ];
  labels: { id: string; name: string; seq: number }[] = [
    { id: "L1", name: "Waiting For", seq: 0 },
    { id: "L2", name: "PhoneCall", seq: 0 },
  ];

  /** Stands in for Todoist's date parsing: any words → this date (recurring if "every ..."). */
  static WORDS_DATE = "2030-01-15";
  private due(d: { date?: string; string?: string } | null | undefined) {
    if (!d) return null;
    if (d.string) return { date: FakeTodoist.WORDS_DATE, string: d.string, is_recurring: /^every\b/i.test(d.string) };
    return d as { date: string };
  }

  http = async (req: HttpRequest) => {
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
        this.projects.push({ id, name: a.name, seq: ++this.seq });
        if (c.temp_id) temp_id_mapping[c.temp_id] = id;
      } else if (c.type === "item_add") {
        const id = `T${this.nextId++}`;
        const parent = a.parent_id ? this.items.get(a.parent_id) : undefined;
        if (a.parent_id && !parent) throw new Error(`unknown parent ${a.parent_id}`);
        this.items.set(id, {
          id, content: a.content, description: a.description, project_id: a.project_id ?? parent?.project_id ?? "inbox",
          ...(parent ? { parent_id: parent.id } : {}),
          checked: false, is_deleted: false, priority: a.priority ?? 1, due: this.due(a.due), labels: a.labels ?? [], seq: ++this.seq,
        });
        if (c.temp_id) temp_id_mapping[c.temp_id] = id;
      } else {
        const it = this.items.get(a.id)!;
        if (c.type === "item_update") {
          if ("content" in a) it.content = a.content;
          if ("due" in a) it.due = this.due(a.due);
          if ("labels" in a) it.labels = a.labels;
          if ("priority" in a) it.priority = a.priority;
        } else if (c.type === "item_close") it.checked = true;
        else if (c.type === "item_uncomplete") it.checked = false;
        else if (c.type === "item_move" && a.parent_id) {
          it.parent_id = a.parent_id;
          it.project_id = this.items.get(a.parent_id)!.project_id;
        } else if (c.type === "item_move") {
          it.project_id = a.project_id;
          it.parent_id = null;
        }
        it.seq = ++this.seq;
      }
    }
    let items: TodoistItem[] | undefined;
    let full = false;
    if (form.has("resource_types")) {
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
    vault.files.set("Note.md", "# Hi\n- [ ] Call Bob 📅 2026-11-10\n- [x] Old done thing\n- [ ] Secret #notodoist");
    await engine.pushFile("Note.md");
    const lines = vault.files.get("Note.md")!.split("\n");
    expect(lines[1]).toBe("- [ ] Call Bob 📅 2026-11-10 %%td:T1%%");
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
    vault.files.set("Note.md", "- [x] Call Bob about contract 📅 2026-12-01 %%td:T1%%");
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
    expect(vault.files.get("Note.md")).toBe("intro\n  - [x] Call Bob! 📅 2026-11-20 %%td:T1%%\noutro");
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
      vault.files.set("Note.md", "- [ ] Send invoice #[work] 📅 2026-11-10");
      await engine.pushFile("Note.md");
      expect(projectOf("T1")).toBe("P2"); // matched ignoring case
      expect(todoist.items.get("T1")!.content).toBe("Send invoice");
      expect(vault.files.get("Note.md")).toBe("- [ ] Send invoice 📅 2026-11-10 %%td:T1%%");
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
      vault.files.set("Note.md", "- [ ] Call the dentist p1 @PhoneCall 📅 2026-11-10");
      await engine.pull();
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ content: "Call the dentist", priority: 4, labels: ["PhoneCall"] });
      expect(vault.files.get("Note.md")).toBe("- [ ] Call the dentist 📅 2026-11-10 %%td:T1%%");
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

    it("keeps a nested line with a #[Project] in that project on later pushes", async () => {
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Trip\n\t- [ ] Book train #[Work]");
      await engine.pushFile("Note.md");
      const calls = todoist.calls.length;
      await engine.pushFile("Note.md");
      expect(todoist.calls.length).toBe(calls);
      expect(parentOf("Book train")).toBeUndefined();
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

    it("doesn't undo a move made in Todoist", async () => {
      todoist.edit("T4", { parent_id: null });
      await engine.pull();
      await engine.pushFile("Note.md");
      expect(moves()).toEqual([]);
      expect(parentOf("T4")).toBeNull();
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
        "  - [ ] Plan trip today 📅 2030-02-01 %%td:A%%",
        "  \t- [ ] Book flights %%td:C%%",
        "  \t\t- [ ] Pick seats %%td:D%%",
        "  \t- [ ] Book hotel %%td:B%%",
      ]);
      expect(items.map((i) => i.id)).toEqual(["A", "C", "D", "B"]);

      // Without subtasks: just the task.
      const alone = importLines(open.find((i) => i.id === "A")!, open, (id) => engine.isLinked(id), "", "\t", false);
      expect(alone.lines).toEqual(["- [ ] Plan trip today 📅 2030-02-01 %%td:A%%"]);
      expect(alone.items.map((i) => i.id)).toEqual(["A"]);
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
      expect(vault.files.get("Note.md")).toBe(`- [ ] Send invoice 📅 ${D} %%td:T1%%`);
      expect(state.tasks.T1.base.due).toBe(D);
    });

    it("changes a synced task's date, and the words beat an edited 📅", async () => {
      vault.files.set("Note.md", "- [ ] Pay rent 📅 2026-11-01");
      await engine.pushFile("Note.md");
      await engine.pull();
      vault.files.set("Note.md", "- [ ] Pay rent every month 📅 2026-12-01 %%td:T1%%");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")!.due).toMatchObject({ date: D, is_recurring: true });
      expect(vault.files.get("Note.md")).toBe("- [ ] Pay rent 📅 2026-12-01 %%td:T1%%");
      await engine.pull();
      expect(vault.files.get("Note.md")).toBe(`- [ ] Pay rent 📅 ${D} %%td:T1%%`);
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
      vault.files.set("Note.md", "- [ ] Call Bob @phonecall @[waiting for] 📅 2026-11-10");
      await engine.pushFile("Note.md");
      expect(todoist.items.get("T1")).toMatchObject({ content: "Call Bob", labels: ["PhoneCall", "Waiting For"] });
      expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob 📅 2026-11-10 %%td:T1%%");
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
    vault.files.set("Note.md", "- [ ] Call Bob #[Work] 📅 2026-11-10");
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
