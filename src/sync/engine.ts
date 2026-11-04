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
}

export interface PushResult {
  /** True if something was deferred (e.g. task on the cursor line) and the file should be retried. */
  deferred: boolean;
}

const BATCH = 90;

export class SyncEngine {
  private busy: Promise<unknown> = Promise.resolve();

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
    const match = Object.entries(this.state.projects).find(([, p]) => p.name.toLowerCase() === name!.toLowerCase());
    if (!match) this.log(`Project "${name}" not found in Todoist; using Inbox`);
    return match?.[0];
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
    const { canCreate } = this.settings();
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
    if (newUuids.length) await this.save();

    // 2. Build commands.
    const content = await this.vault.read(path);
    const tasks = findTasks(content);
    const commands: Command[] = [];
    const onOk: Record<string, () => void> = {};
    const seenIds = new Set<string>();

    for (const { task } of tasks) {
      const local: TaskFields = { text: task.text, checked: task.checked, due: task.due };

      if (task.pendingUuid) {
        const pend = this.state.pending[task.pendingUuid];
        if (!pend) continue; // created by another device; it will resolve the marker
        pend.path = path;
        const args: Record<string, unknown> = {
          content: task.text,
          description: this.backlink(path, task.pendingUuid),
        };
        const projectId = this.projectIdFor(path);
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
      if (!rec) {
        // Marker appeared here without a record (pasted from another note, or created elsewhere): adopt it.
        rec = this.state.tasks[id] = { path, base: local };
        continue;
      }
      rec.path = path;
      if (rec.orphaned) continue;

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
      await this.save();
      return { deferred };
    }

    // 3. Send.
    const mapping: Record<string, string> = {};
    for (let i = 0; i < commands.length; i += BATCH) {
      const batch = commands.slice(i, i + BATCH);
      const res = await this.client.sync({ commands: batch });
      Object.assign(mapping, res.temp_id_mapping ?? {});
      for (const cmd of batch) {
        const status = res.sync_status?.[cmd.uuid];
        if (status === "ok") onOk[cmd.uuid]?.();
        else if (status) this.log(`Todoist rejected ${cmd.type}: ${status.error}`);
      }
    }

    // 4. Replace pending markers with real ids.
    const resolved = Object.entries(mapping).filter(([tmp]) => this.state.pending[tmp]);
    if (resolved.length) await this.resolvePending(path, resolved);

    await this.save();
    return { deferred };
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
        lines[idx] = serializeTask({ ...task, pendingUuid: null, todoistId: realId });
        this.state.tasks[realId] = { path, base: { text: task.text, checked: task.checked, due: task.due } };
      }
      return lines.join("\n");
    });
  }

  // ---------------------------------------------------------------- pull

  pull(): Promise<void> {
    return this.exclusive(() => this.pullInner());
  }

  private async pullInner(): Promise<void> {
    const res = await this.client.sync({
      syncToken: this.state.syncToken ?? "*",
      resourceTypes: ["items", "projects"],
    });

    if (res.full_sync) this.state.projects = {};
    for (const p of res.projects ?? []) {
      if (p.is_deleted) delete this.state.projects[p.id];
      else this.state.projects[p.id] = { name: p.name, color: p.color, inbox: p.inbox_project };
    }

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
