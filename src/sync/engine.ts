import {
  findLineByMarker,
  findTasks,
  parseTaskLine,
  PENDING,
  serializeTask,
  type ParsedTask,
  type TaskFields,
} from "../parse/taskLine";
import { dueDate, uuid as makeUuid, type Command, type TodoistClient, type TodoistItem } from "../todoist/client";
import { isEmpty, merge } from "./merge";
import type { SyncState } from "./state";

/** The slice of Obsidian the engine needs. Implemented in main.ts; faked in tests. */
export interface VaultAdapter {
  read(path: string): Promise<string>;
  process(path: string, fn: (content: string) => string): Promise<void>;
  mtime(path: string): number;
  frontmatter(path: string): Record<string, unknown> | undefined;
  markdownFiles(): string[];
  vaultName(): string;
}

export interface EngineSettings {
  excludedFolders: string[];
  folderProjects: { folder: string; project: string }[];
  /** Whether this device may create new Todoist tasks (guards against duplicate creation across devices). */
  canCreate: boolean;
}

export interface PushOptions {
  /** Line currently being edited; new tasks on it are not created yet. */
  skipLine?: number;
  /**
   * The open editor for this note, read when the push actually runs (after any queued sync):
   * its full text and cursor line. If the text differs from the saved file, the user is mid-edit
   * and the cursor line can't be trusted to point at the same line on disk, so the whole push is
   * deferred until Obsidian has saved. Otherwise the cursor line is treated as `skipLine`.
   */
  editor?: () => { content: string; cursorLine: number } | undefined;
  /** Push edits to existing tasks but create nothing new (tasks or projects) from this note now. */
  noCreate?: boolean;
}

export interface PushResult {
  /** True if something was deferred (e.g. task on the cursor line) and the file should be retried. */
  deferred: boolean;
}

const BATCH = 90;

export class SyncEngine {
  private busy: Promise<unknown> = Promise.resolve();
  /** Task ids we've already run a full sync for, to fetch their details (see missingDetails). */
  private fetchTried = new Set<string>();

  constructor(
    private client: TodoistClient,
    private vault: VaultAdapter,
    public state: SyncState,
    private settings: () => EngineSettings,
    private save: () => Promise<void>,
    private log: (msg: string) => void = () => {},
  ) {}

  /** Serialise all sync operations so pushes and pulls never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => {});
    return next;
  }

  // ---------------------------------------------------------------- eligibility

  isFileEligible(path: string): boolean {
    if (!path.endsWith(".md")) return false;
    const s = this.settings();
    for (const folder of s.excludedFolders) {
      const f = folder.replace(/\/+$/, "");
      if (f && (path === f || path.startsWith(f + "/"))) return false;
    }
    const fm = this.vault.frontmatter(path);
    if (fm && (fm["todoist"] === false || fm["todoist"] === "false")) return false;
    return true;
  }

  /** Should an unmarked task on this line become a Todoist task? */
  private wantsCreate(task: ParsedTask): boolean {
    return !task.excluded && !task.checked && !task.todoistId && !task.pendingUuid;
  }

  projectIdFor(path: string): string | undefined {
    const fm = this.vault.frontmatter(path);
    let name = typeof fm?.["todoist_project"] === "string" ? (fm["todoist_project"] as string) : undefined;
    if (!name) {
      let best = -1;
      for (const { folder, project } of this.settings().folderProjects) {
        const f = folder.replace(/\/+$/, "");
        if ((path.startsWith(f + "/") || f === "") && f.length > best) {
          best = f.length;
          name = project;
        }
      }
    }
    if (!name) return undefined; // Inbox
    const id = this.findProject(name);
    if (!id) this.log(`Project "${name}" not found in Todoist; using Inbox`);
    return id;
  }

  /** Id of the active (non-archived) project with this name, ignoring case and surrounding spaces. */
  findProject(name: string): string | undefined {
    const key = projectKey(name);
    return Object.entries(this.state.projects).find(([, p]) => !p.archived && projectKey(p.name) === key)?.[0];
  }

  private backlink(path: string, pendingUuid: string): string {
    const q = `vault=${encodeURIComponent(this.vault.vaultName())}&file=${encodeURIComponent(path)}&it=${pendingUuid}`;
    return `[Open in Obsidian](obsidian://open?${q})`;
  }

  // ---------------------------------------------------------------- backfill

  /** Count open, unmarked checkboxes that a backfill would create, grouped by folder. */
  async countBackfill(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const path of this.vault.markdownFiles()) {
      if (!this.isFileEligible(path)) continue;
      const n = findTasks(await this.vault.read(path)).filter((t) => this.wantsCreate(t.task)).length;
      if (n) {
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
        counts[folder] = (counts[folder] ?? 0) + n;
      }
    }
    return counts;
  }

  async runBackfill(): Promise<void> {
    this.state.backfillDone = true;
    await this.save();
    for (const path of this.vault.markdownFiles()) {
      if (this.isFileEligible(path)) await this.pushFile(path);
    }
  }

  // ---------------------------------------------------------------- push

  pushFile(path: string, opts: PushOptions = {}): Promise<PushResult> {
    return this.exclusive(() => this.pushFileInner(path, opts));
  }

  private async pushFileInner(path: string, opts: PushOptions): Promise<PushResult> {
    if (!this.state.backfillDone || !this.isFileEligible(path)) return { deferred: false };
    if (opts.editor) {
      const disk = await this.vault.read(path);
      const ed = opts.editor();
      if (ed) {
        if (ed.content !== disk) return { deferred: true };
        opts = { ...opts, skipLine: ed.cursorLine };
      }
    }
    const canCreate = this.settings().canCreate && !opts.noCreate;
    let deferred = false;

    // 1. Assign pending markers to new tasks and write them to disk first, so a crash
    //    or a second device never results in an unmarked line being created twice.
    const newUuids: string[] = [];
    await this.vault.process(path, (content) => {
      const lines = content.split("\n");
      for (const { line, task } of findTasks(content)) {
        if (!this.wantsCreate(task)) continue;
        if (!canCreate) continue;
        if (line === opts.skipLine) {
          deferred = true;
          continue;
        }
        const id = makeUuid();
        newUuids.push(id);
        lines[line] = serializeTask({ ...task, pendingUuid: id });
      }
      return newUuids.length ? lines.join("\n") : content;
    });
    for (const id of newUuids) this.state.pending[id] = { path, createdAt: Date.now() };
    if (newUuids.length) {
      this.log(`${path}: creating ${newUuids.length} new task(s)`);
      await this.save();
    }

    // 2. Build commands.
    const content = await this.vault.read(path);
    const tasks = findTasks(content);
    const commands: Command[] = [];
    const onOk: Record<string, () => void> = {};
    const seenIds = new Set<string>();
    /** Real task ids whose `#[Project]` reference should be removed from the line. */
    const stripRefs = new Set<string>();
    /** Projects created by this push: temp id → lower-cased name. */
    const newProjects = new Map<string, string>();

    /** Project id for a `#[Name]` reference, queueing a `project_add` if it doesn't exist yet. */
    const projectTarget = (name: string): string | undefined => {
      const existing = this.findProject(name);
      if (existing) return existing;
      const key = projectKey(name);
      for (const [tmp, k] of newProjects) if (k === key) return tmp;
      if (this.state.pendingProjects[key]) {
        // An earlier create of this project got no answer. Wait for the next pull, which either
        // brings it in or shows it was never made, rather than risk creating it twice.
        deferred = true;
        return undefined;
      }
      if (!canCreate) return undefined; // hold; a device that may create will file it
      const tmp = makeUuid();
      this.state.pendingProjects[key] = tmp;
      newProjects.set(tmp, key);
      commands.push({ type: "project_add", uuid: tmp, temp_id: tmp, args: { name: name.trim() } });
      return tmp;
    };

    for (const { line, task } of tasks) {
      const local: TaskFields = { text: task.text, checked: task.checked, due: task.due };

      if (task.pendingUuid) {
        const pend = this.state.pending[task.pendingUuid];
        if (!pend) continue; // created by another device; it will resolve the marker
        pend.path = path;
        const args: Record<string, unknown> = {
          content: task.text,
          description: this.backlink(path, task.pendingUuid),
        };
        const projectId = task.projectRef ? projectTarget(task.projectRef) : this.projectIdFor(path);
        if (task.projectRef && !projectId) continue; // project can't be created on this device
        if (projectId) args.project_id = projectId;
        if (task.due) args.due = { date: task.due };
        // Same uuid on retry: Todoist de-duplicates commands it has already applied.
        commands.push({ type: "item_add", uuid: task.pendingUuid, temp_id: task.pendingUuid, args });
        continue;
      }

      if (!task.todoistId) continue;
      const id = task.todoistId;
      seenIds.add(id);
      let rec = this.state.tasks[id];
      let adopted = false;
      if (!rec) {
        // Marker appeared here without a record (pasted from another note, or created elsewhere): adopt it.
        rec = this.state.tasks[id] = { path, base: local };
        adopted = true;
      }
      rec.path = path;
      if (rec.orphaned) continue;

      // `#[Project]` on a synced task: move it, then strip the reference. Not while the line is being edited.
      if (task.projectRef) {
        if (line === opts.skipLine) {
          deferred = true;
        } else {
          const target = projectTarget(task.projectRef);
          if (target && target === this.state.remote[id]?.projectId) {
            stripRefs.add(id); // already there
          } else if (target) {
            const cmd: Command = { type: "item_move", uuid: makeUuid(), args: { id, project_id: target } };
            commands.push(cmd);
            onOk[cmd.uuid] = () => stripRefs.add(id);
          }
        }
      }
      if (adopted) continue;

      const { push } = merge(rec.base, local, rec.base, 0, 0);
      if (isEmpty(push)) continue;
      for (const cmd of commandsFor(id, push)) {
        commands.push(cmd);
        onOk[cmd.uuid] = () => {
          rec!.base = { ...rec!.base, ...pickFields(local, push) };
        };
      }
    }

    // Records for this file whose marker vanished: unlink (never delete in Todoist).
    for (const [id, rec] of Object.entries(this.state.tasks)) {
      if (rec.path === path && !seenIds.has(id)) {
        if (!content.includes(`%%td:${id}%%`)) delete this.state.tasks[id];
      }
    }

    if (!commands.length) {
      if (stripRefs.size) await this.stripProjectRefs(path, stripRefs);
      await this.save();
      return { deferred };
    }

    // 3. Send. Persist in-flight project creates first, so a crash mid-request is detected on restart.
    if (newProjects.size) await this.save();
    const mapping: Record<string, string> = {};
    for (let i = 0; i < commands.length; i += BATCH) {
      const batch = commands.slice(i, i + BATCH);
      // A project created in an earlier batch is referenced by its real id from here on.
      for (const cmd of batch) {
        const pid = cmd.args.project_id;
        if (typeof pid === "string" && mapping[pid]) cmd.args.project_id = mapping[pid];
      }
      const res = await this.client.sync({ commands: batch });
      Object.assign(mapping, res.temp_id_mapping ?? {});
      for (const cmd of batch) {
        const status = res.sync_status?.[cmd.uuid];
        if (status === "ok") onOk[cmd.uuid]?.();
        else if (status) this.log(`Todoist rejected ${cmd.type}: ${status.error}`);
      }
    }

    // New projects: record them so chips and later references resolve without waiting for a pull.
    for (const [tmp, key] of newProjects) {
      const realId = mapping[tmp];
      if (!realId) continue; // de-duplicated retry; the next pull brings the project in
      const cmd = commands.find((c) => c.uuid === tmp)!;
      this.state.projects[realId] = { name: cmd.args.name as string };
      delete this.state.pendingProjects[key];
    }
    for (const cmd of commands) {
      if (cmd.type !== "item_move" || !stripRefs.has(cmd.args.id as string)) continue;
      const meta = this.state.remote[cmd.args.id as string];
      const pid = cmd.args.project_id as string;
      if (meta) meta.projectId = mapping[pid] ?? pid;
    }

    // 4. Replace pending markers with real ids, and strip project references that have been applied.
    this.log(`${path}: sent ${commands.map((c) => c.type).join(", ")}`);
    const resolved = Object.entries(mapping).filter(([tmp]) => this.state.pending[tmp]);
    if (resolved.length) await this.resolvePending(path, resolved);
    if (stripRefs.size) await this.stripProjectRefs(path, stripRefs);

    await this.save();
    return { deferred };
  }

  private async stripProjectRefs(path: string, ids: Set<string>): Promise<void> {
    await this.vault.process(path, (content) => {
      const lines = content.split("\n");
      let changed = false;
      for (const id of ids) {
        const idx = findLineByMarker(lines, id);
        const task = idx >= 0 ? parseTaskLine(lines[idx]) : null;
        if (!task?.projectRef) continue;
        lines[idx] = serializeTask({ ...task, projectRef: null });
        changed = true;
      }
      return changed ? lines.join("\n") : content;
    });
  }

  private async resolvePending(path: string, pairs: [string, string][]): Promise<void> {
    await this.vault.process(path, (content) => {
      const lines = content.split("\n");
      for (const [tmp, realId] of pairs) {
        const idx = findLineByMarker(lines, PENDING + tmp);
        delete this.state.pending[tmp];
        if (idx < 0) continue;
        const task = parseTaskLine(lines[idx]);
        if (!task) continue;
        // The create carried the line's `#[Project]`, so the reference has done its job.
        lines[idx] = serializeTask({ ...task, pendingUuid: null, todoistId: realId, projectRef: null });
        this.state.tasks[realId] = { path, base: { text: task.text, checked: task.checked, due: task.due } };
      }
      return lines.join("\n");
    });
  }

  // ---------------------------------------------------------------- pull

  pull(): Promise<void> {
    return this.exclusive(() => this.pullInner());
  }

  /**
   * Linked tasks this device has no Todoist details for (project, due date, ...), and hasn't yet
   * tried to fetch. Happens when a task was created on another device: its marker arrives here by
   * Obsidian Sync after this device's pulls have already gone past the task.
   */
  missingDetails(): string[] {
    return Object.entries(this.state.tasks)
      .filter(([id, rec]) => !rec.orphaned && !this.state.remote[id] && !this.fetchTried.has(id))
      .map(([id]) => id);
  }

  private async pullInner(): Promise<void> {
    // Projects saved before archived/parent were tracked need one full sync to fill them in, and so
    // do tasks we have no details for, since an incremental sync only returns tasks that changed.
    const stale = Object.values(this.state.projects).some((p) => p.parentId === undefined);
    const missing = this.missingDetails();
    // Tried once per session: a completed or deleted task isn't returned, and mustn't force a full sync every time.
    for (const id of missing) this.fetchTried.add(id);
    if (missing.length) this.log(`fetching details for ${missing.length} task(s) linked elsewhere`);
    const res = await this.client.sync({
      syncToken: stale || missing.length ? "*" : (this.state.syncToken ?? "*"),
      resourceTypes: ["items", "projects"],
    });

    if (res.full_sync) this.state.projects = {};
    const deletedProjects = new Set<string>();
    for (const p of res.projects ?? []) {
      if (p.is_deleted) {
        delete this.state.projects[p.id];
        deletedProjects.add(p.id);
      } else {
        this.state.projects[p.id] = {
          name: p.name,
          color: p.color,
          inbox: p.inbox_project,
          archived: p.is_archived,
          parentId: p.parent_id ?? null,
        };
      }
    }
    // Any unconfirmed project create has now either arrived above or never happened.
    this.state.pendingProjects = {};

    const byPath = new Map<string, TodoistItem[]>();
    const pendingResolutions = new Map<string, [string, string][]>();

    for (const item of res.items ?? []) {
      // Creation that we sent but never saw a temp_id mapping for (e.g. de-duplicated retry).
      const it = /[?&]it=([0-9a-f-]{36})/.exec(item.description ?? "")?.[1];
      if (it && this.state.pending[it] && !this.state.tasks[item.id]) {
        const p = this.state.pending[it].path;
        pendingResolutions.set(p, [...(pendingResolutions.get(p) ?? []), [it, item.id]]);
      }

      const rec = this.state.tasks[item.id];
      if (!rec) continue;
      if (item.is_deleted) {
        rec.orphaned = true;
        delete this.state.remote[item.id];
        continue;
      }
      this.state.remote[item.id] = {
        projectId: item.project_id,
        priority: item.priority,
        due: dueDate(item.due),
        dueString: item.due?.string,
        recurring: item.due?.is_recurring,
        checked: item.checked,
        labels: item.labels,
      };
      byPath.set(rec.path, [...(byPath.get(rec.path) ?? []), item]);
    }

    // Deleting a project deletes its tasks, but Todoist reports only the project, not each task.
    // Checked after the items above, so a task moved out of the project first is left alone.
    if (deletedProjects.size) {
      for (const [id, meta] of Object.entries(this.state.remote)) {
        const rec = this.state.tasks[id];
        if (!rec || !deletedProjects.has(meta.projectId)) continue;
        rec.orphaned = true;
        delete this.state.remote[id];
      }
    }

    for (const [path, pairs] of pendingResolutions) await this.resolvePending(path, pairs);

    const commands: Command[] = [];
    for (const [path, items] of byPath) {
      const mtime = this.vault.mtime(path);
      // Merge against the current content first; only write the note if a line actually changes,
      // so remote-only changes (priority, labels, project) don't rewrite the file and bump its mtime.
      let result = this.mergeFile(await this.vault.read(path), items, mtime);
      if (result.changed) {
        await this.vault.process(path, (content) => {
          result = this.mergeFile(content, items, mtime);
          return result.changed ? result.content : content;
        });
      }
      for (const [id, base] of result.bases) this.state.tasks[id].base = base;
      for (const c of result.conflicts) this.log(c);
      commands.push(...result.commands);
    }

    if (commands.length) await this.client.sync({ commands });
    this.state.syncToken = res.sync_token;
    await this.save();
  }

  /** Pure: three-way merge each pulled item against its line in `content`. */
  private mergeFile(content: string, items: TodoistItem[], mtime: number) {
    const lines = content.split("\n");
    const commands: Command[] = [];
    const bases = new Map<string, TaskFields>();
    const conflicts: string[] = [];
    let changed = false;
    for (const item of items) {
      const rec = this.state.tasks[item.id];
      const idx = findLineByMarker(lines, item.id);
      if (idx < 0) continue; // moved; the index will re-adopt it on the next push
      const task = parseTaskLine(lines[idx]);
      if (!task) continue;
      const local: TaskFields = { text: task.text, checked: task.checked, due: task.due };
      const remote: TaskFields = { text: item.content, checked: item.checked, due: dueDate(item.due) };
      const remoteAt = item.updated_at ? Date.parse(item.updated_at) : 0;
      const m = merge(rec.base, local, remote, mtime, remoteAt);
      if (m.conflicts.length) conflicts.push(`Conflict on "${task.text}" (${m.conflicts.join(", ")}); resolved`);
      if (!isEmpty(m.pull)) {
        const next = serializeTask({ ...task, ...m.pull });
        if (next !== lines[idx]) {
          lines[idx] = next;
          changed = true;
        }
      }
      if (!isEmpty(m.push)) commands.push(...commandsFor(item.id, m.push));
      bases.set(item.id, m.merged);
    }
    return { content: lines.join("\n"), changed, commands, bases, conflicts };
  }

  // ---------------------------------------------------------------- vault events

  onRename(oldPath: string, newPath: string): void {
    for (const rec of Object.values(this.state.tasks)) if (rec.path === oldPath) rec.path = newPath;
    for (const p of Object.values(this.state.pending)) if (p.path === oldPath) p.path = newPath;
    void this.save();
  }

  onDelete(path: string): void {
    for (const [id, rec] of Object.entries(this.state.tasks)) if (rec.path === path) delete this.state.tasks[id];
    void this.save();
  }
}

/** Comparison key for project names: case- and whitespace-insensitive. */
export function projectKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function pickFields(src: TaskFields, keys: Partial<TaskFields>): Partial<TaskFields> {
  const out: Partial<TaskFields> = {};
  for (const k of Object.keys(keys) as (keyof TaskFields)[]) (out as Record<string, unknown>)[k] = src[k];
  return out;
}

export function commandsFor(id: string, change: Partial<TaskFields>): Command[] {
  const cmds: Command[] = [];
  const args: Record<string, unknown> = { id };
  if ("text" in change) args.content = change.text;
  if ("due" in change) args.due = change.due ? { date: change.due } : null;
  if (Object.keys(args).length > 1) cmds.push({ type: "item_update", uuid: makeUuid(), args });
  if ("checked" in change) {
    cmds.push({ type: change.checked ? "item_close" : "item_uncomplete", uuid: makeUuid(), args: { id } });
  }
  return cmds;
}
