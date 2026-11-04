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
      if (c.type === "item_add") {
        const id = `T${this.nextId++}`;
        this.items.set(id, {
          id, content: a.content, description: a.description, project_id: a.project_id ?? "inbox",
          checked: false, is_deleted: false, priority: 1, due: a.due ?? null, seq: ++this.seq,
        });
        if (c.temp_id) temp_id_mapping[c.temp_id] = id;
      } else {
        const it = this.items.get(a.id)!;
        if (c.type === "item_update") {
          if ("content" in a) it.content = a.content;
          if ("due" in a) it.due = a.due;
        } else if (c.type === "item_close") it.checked = true;
        else if (c.type === "item_uncomplete") it.checked = false;
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
        projects: full ? [{ id: "inbox", name: "Inbox", inbox_project: true }, { id: "P2", name: "Work" }] : [],
        sync_status, temp_id_mapping,
      },
    };
  };

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

  it("does not create tasks on a device with creation disabled", async () => {
    settings.canCreate = false;
    vault.files.set("Note.md", "- [ ] phone task");
    await engine.pushFile("Note.md");
    expect(todoist.items.size).toBe(0);
    expect(vault.files.get("Note.md")).toBe("- [ ] phone task");
  });

  it("counts backfill candidates per folder", async () => {
    vault.files.set("A.md", "- [ ] a\n- [x] done");
    vault.files.set("Projects/X.md", "- [ ] b\n- [ ] c %%td:T9%%\n- [ ] d");
    vault.files.set("Templates/T.md", "- [ ] t");
    expect(await engine.countBackfill()).toEqual({ "/": 1, Projects: 2 });
  });
});
