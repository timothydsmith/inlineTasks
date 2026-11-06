import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine, type EngineSettings, type VaultAdapter } from "../src/sync/engine";
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
      if (c.type === "label_add") {
        this.labels.push({ id: `LX${this.labels.length}`, name: a.name, seq: ++this.seq });
      } else if (c.type === "project_add") {
        const id = `PX${this.projects.length}`;
        this.projects.push({ id, name: a.name, seq: ++this.seq });
        if (c.temp_id) temp_id_mapping[c.temp_id] = id;
      } else if (c.type === "item_add") {
        const id = `T${this.nextId++}`;
        this.items.set(id, {
          id, content: a.content, description: a.description, project_id: a.project_id ?? "inbox",
          checked: false, is_deleted: false, priority: a.priority ?? 1, due: a.due ?? null, labels: a.labels ?? [], seq: ++this.seq,
        });
        if (c.temp_id) temp_id_mapping[c.temp_id] = id;
      } else {
        const it = this.items.get(a.id)!;
        if (c.type === "item_update") {
          if ("content" in a) it.content = a.content;
          if ("due" in a) it.due = a.due;
          if ("labels" in a) it.labels = a.labels;
          if ("priority" in a) it.priority = a.priority;
        } else if (c.type === "item_close") it.checked = true;
        else if (c.type === "item_uncomplete") it.checked = false;
        else if (c.type === "item_move") it.project_id = a.project_id;
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
    todoist.edit("T1", { content: "Call Bob today", project_id: "P2" });
    vault.files.set("Templates/T.md", "- [ ] template %%td:T1%%");
    // A second device, starting empty.
    const fresh = { ...emptyState(), backfillDone: true };
    const other = new SyncEngine(new TodoistClient(() => "tok", todoist.http), vault, fresh, () => settings, async () => {});
    expect(await other.linkExisting()).toBe(1); // excluded folders are skipped
    expect(fresh.tasks.T1).toEqual({ path: "Note.md", base: { text: "Call Bob", checked: false, due: null } });
    await other.pull();
    expect(fresh.remote.T1?.projectId).toBe("P2");
    expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob today %%td:T1%%"); // Todoist's edit merged in
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
    vault.files.set("Note.md", "- [ ] Call Bob today %%td:T1%%\n- [ ] typed on the phone");
    await engine.pushFile("Note.md", { noCreate: true });
    expect(todoist.items.size).toBe(1);
    expect(todoist.items.get("T1")!.content).toBe("Call Bob today");
    expect(vault.files.get("Note.md")).toBe("- [ ] Call Bob today %%td:T1%%\n- [ ] typed on the phone");
  });

  it("counts backfill candidates per folder", async () => {
    vault.files.set("A.md", "- [ ] a\n- [x] done");
    vault.files.set("Projects/X.md", "- [ ] b\n- [ ] c %%td:T9%%\n- [ ] d");
    vault.files.set("Templates/T.md", "- [ ] t");
    expect(await engine.countBackfill()).toEqual({ "/": 1, Projects: 2 });
  });
});
