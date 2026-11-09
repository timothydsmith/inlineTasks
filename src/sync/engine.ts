import {
  blockEnd,
  createsTask,
  findLineByMarker,
  findTasks,
  isCancelledStatus,
  linePriority,
  needsRelayout,
  parentLine,
  parseTaskLine,
  PENDING,
  serializeTask,
  withDoneDate,
  withLinePriority,
  withTitle,
  type ParsedTask,
  type TaskFields,
} from "../parse/taskLine";
import { dueDate, uuid as makeUuid, type Command, type TodoistClient, type TodoistItem } from "../todoist/client";
import { isoDate } from "./dates";
import { historyLines, type CompletionEvent } from "./history";
import { isEmpty, merge } from "./merge";
import { canonicalRule, todoistRule } from "./recurrence";
import { childProject, findProjectId, splitProjectPath } from "./projects";
import { compareSiblings, inOrderOf, moveBlock, reorderBlocks, reorderKeys, sameOrder, type Sibling } from "./order";
import type { SyncState, TaskRecord } from "./state";

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
  /** One level of list indentation, for lines the sync re-indents. Defaults to a tab. */
  indent?: string;
  /** Write Todoist priorities as Tasks priorities on the line, and ✅ done dates. */
  tasksFields?: boolean;
  /**
   * Tasks puts a repeating task's next occurrence on the line below the ticked one (its "next
   * recurrence appears on the line below" setting), so history lines go above the task's line.
   */
  historyAbove?: boolean;
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

/** A task's fields as synced, to write to each of its lines (see SyncEngine.writeLines). */
interface LineTarget {
  fields: TaskFields;
  /** Its title before this sync, which its lines may still have (see withTitle). */
  title: string;
  /** When Todoist completed it, for the `✅` date of lines ticked by this sync. */
  completedAt?: string | null;
  /** Its lines are from before deadlines synced: a lone `📅` is its date (see readLine). */
  legacy?: boolean;
}
/** How long a repeating task's completions in Todoist are looked for in its activity log, which can lag. */
export const HISTORY_WAIT_MS = 15 * 60_000;
/**
 * How long a `🏁 delete` line must have been gone before its Todoist task is completed, so a line
 * cut from one note and pasted into another is found there first.
 */
export const GONE_GRACE_MS = 30_000;

export class SyncEngine {
  private busy: Promise<unknown> = Promise.resolve();
  /** Task ids we've already run a full sync for, to fetch their details (see missingDetails). */
  private fetchTried = new Set<string>();
  /** A push sent something only a pull can complete (a due date in words). See takePullRequest. */
  private wantPull = false;
  /** Task ids whose place among their siblings we've already read afresh this session (see syncOrder). */
  private orderTried = new Set<string>();

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
    return createsTask(task);
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

  /** The existing label with this name (its own spelling), ignoring case and surrounding spaces. */
  findLabel(name: string): string | undefined {
    const key = labelKey(name);
    return Object.values(this.state.labels).find((l) => labelKey(l.name) === key)?.name;
  }

  /**
   * Id of the active (non-archived) project with this name, ignoring case and surrounding spaces,
   * or at the end of this path of nested projects, `Work/Clients/Acme` (see findProjectId).
   */
  findProject(name: string): string | undefined {
    return findProjectId(this.state, name);
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

  /**
   * Rewrite the lines in the vault written by earlier versions, so they read the same now:
   * - before 0.4.0, the marker went after the fields, which hides them from the Tasks plugin;
   * - before deadlines synced, `📅` was the Todoist date, which is now `⏳` (see readLine).
   * Lines being edited are left to their next push.
   */
  migrateVault(skip?: { path: string; line: number }): Promise<number> {
    return this.exclusive(async () => {
      let n = 0;
      for (const path of this.vault.markdownFiles()) {
        if (!this.isFileEligible(path)) continue;
        const migrated = (content: string, upgrade: boolean) => {
          const lines = content.split("\n");
          let k = 0;
          for (const { line, task } of findTasks(content)) {
            if (path === skip?.path && line === skip.line) continue;
            const next = this.migrate(lines[line], task, upgrade);
            if (!next) continue;
            lines[line] = serializeTask(next);
            k++;
          }
          return { content: lines.join("\n"), k };
        };
        // Read first, so notes with nothing to change aren't written.
        if (!migrated(await this.vault.read(path), false).k) {
          migrated(await this.vault.read(path), true); // records whose lines needn't change
          continue;
        }
        await this.vault.process(path, (content) => {
          const r = migrated(content, true);
          n += r.k;
          return r.k ? r.content : content;
        });
      }
      this.state.relaidOut = true;
      this.state.datesMigrated = true;
      await this.save();
      return n;
    });
  }

  /** Whether a task's record is from before deadlines synced, when its line's `📅` was the Todoist date. */
  private isLegacy(rec: TaskRecord | undefined): boolean {
    return !!rec && !("deadline" in rec.base);
  }

  /**
   * A synced line's task, its words read as its title as last synced (see withTitle). On a line
   * last synced before deadlines did, with only a `📅` date, that date is the Todoist date: the
   * line is read as if it had it as `⏳`, and is written that way when next rewritten.
   */
  private readLine(task: ParsedTask, rec: TaskRecord | undefined): ParsedTask {
    return this.legacyDates(task.todoistId ? withTitle(task, rec?.base.text) : task, rec);
  }

  /** The task with a `📅` read as the Todoist date, if its line is from before deadlines synced (see readLine). */
  private legacyDates(t: ParsedTask, rec: TaskRecord | undefined): ParsedTask {
    return this.isLegacy(rec) && t.deadline && !t.due ? { ...t, due: t.deadline, deadline: null } : t;
  }

  /**
   * The task on a line as an earlier version's line should be written now, or null if it's fine.
   * With `upgrade`, its record is marked as synced with deadlines, since its line now reads right.
   */
  private migrate(line: string, task: ParsedTask, upgrade: boolean): ParsedTask | null {
    const rec = task.todoistId ? this.state.tasks[task.todoistId] : undefined;
    const t = task.todoistId ? withTitle(task, rec?.base.text) : task;
    const next = this.legacyDates(t, rec);
    if (upgrade && rec && this.isLegacy(rec)) rec.base = { ...rec.base, deadline: null };
    return next === t && !needsRelayout(line, task) ? null : next;
  }

  private tasksFields(): boolean {
    return !!this.settings().tasksFields;
  }

  /**
   * A line's synced fields: the deadline too, unless its record is from before deadlines synced
   * (see readLine), and the priority when Tasks fields are written.
   */
  private localFields(task: ParsedTask, legacy = false): TaskFields {
    const f: TaskFields = { text: task.text, checked: task.checked, due: task.due };
    if (!legacy) f.deadline = task.deadline ?? null;
    if (this.tasksFields()) {
      f.priority = linePriority(task);
      const rule = task.fields?.recurrence;
      const r = rule ? canonicalRule(rule) : null;
      if (r !== undefined) f.recurrence = r; // a rule Todoist wouldn't understand stays on the line
    }
    return f;
  }

  /** A Todoist task's synced fields, as `localFields` gives a line's. */
  private remoteFields(item: TodoistItem, legacy = false): TaskFields {
    const f: TaskFields = { text: item.content, checked: item.checked, due: dueDate(item.due) };
    if (!legacy) f.deadline = item.deadline?.date ?? null;
    if (this.tasksFields()) {
      f.priority = 5 - item.priority;
      const r = item.due?.is_recurring ? (item.due.string ? canonicalRule(item.due.string) : undefined) : null;
      if (r !== undefined) f.recurrence = r; // a repeat Tasks wouldn't understand stays in Todoist
    }
    return f;
  }

  /**
   * The Todoist due object for a task's date and repeat, from its fields as they're to be synced:
   * - a repeat in Todoist that the line doesn't track (Tasks fields not written, or a rule Tasks
   *   wouldn't understand) is kept, with the line's date as its next one;
   * - otherwise the line's `🔁` rule, from the line's date, or the date alone.
   * Todoist reads a date with a repeat as its next occurrence.
   */
  private dueArg(id: string, f: TaskFields): Record<string, unknown> | null {
    const meta = this.state.remote[id];
    const theirs = meta?.recurring ? meta.dueString : undefined;
    if (theirs && (f.recurrence === undefined || canonicalRule(theirs) === undefined)) {
      return f.due ? { date: f.due, string: theirs } : null;
    }
    if (f.recurrence) return { string: todoistRule(f.recurrence), ...(f.due ? { date: f.due } : {}), lang: "en" };
    return f.due ? { date: f.due } : null;
  }

  /**
   * Lines the Tasks plugin wrote when a repeating task was ticked: it adds the next occurrence as
   * a new line, copying the marker, and leaves the ticked line done. The ticked copies (those with
   * a `🔁`, beside exactly one open line) lose their marker and stay as history; the open line is
   * the task. Returns the ids of the tasks so repeated.
   */
  private unlinkRepeated(lines: string[], found: { line: number; task: ParsedTask }[]): Set<string> {
    const byId = new Map<string, { line: number; task: ParsedTask }[]>();
    for (const f of found) if (f.task.todoistId) byId.set(f.task.todoistId, [...(byId.get(f.task.todoistId) ?? []), f]);
    const repeated = new Set<string>();
    for (const [id, group] of byId) {
      if (group.length < 2) continue;
      const done = group.filter((g) => g.task.checked);
      if (group.length - done.length !== 1 || !done.every((g) => g.task.fields?.recurrence)) continue;
      const rec = this.state.tasks[id];
      if (!rec || rec.orphaned) continue;
      for (const g of done) lines[g.line] = serializeTask({ ...withTitle(g.task, rec.base.text), todoistId: null });
      repeated.add(id);
    }
    return repeated;
  }

  /**
   * The task on a line as it should be written before it's synced, or null if the line is fine:
   * - in the current layout, its marker before its fields (see needsRelayout);
   * - with Tasks fields written, a `p1`–`p4` reference becomes the Tasks priority, which then
   *   syncs, and a task ticked here since the last sync gets a ✅ date, which unticking removes.
   */
  private tidy(line: string, task: ParsedTask): ParsedTask | null {
    const rec = task.todoistId ? this.state.tasks[task.todoistId] : undefined;
    const t = task.todoistId ? withTitle(task, rec?.base.text) : task;
    const migrated = this.migrate(line, task, true);
    let next = migrated ?? t;
    if (this.tasksFields()) {
      if (t.priorityRef && (t.todoistId || t.pendingUuid || createsTask(t))) {
        next = { ...next, priorityRef: null, fields: withLinePriority(next.fields, t.priorityRef) };
      }
      if (rec && !rec.orphaned) {
        if (t.checked && !isCancelledStatus(t.status) && !t.fields?.done && !rec.base.checked) {
          next = { ...next, fields: withDoneDate(next.fields, isoDate(new Date())) };
        } else if (!t.checked && t.fields?.done) {
          next = { ...next, fields: withDoneDate(next.fields, null) };
        }
      }
    }
    return migrated || next !== t ? next : null;
  }

  /**
   * Link every `%%td:<id>%%` marker in the vault that this device has no record of, using the line
   * as the merge base. For a device starting without sync state (a new device, or cleared app
   * data): the next pull then fetches the tasks' details, and any change made in Todoist since is
   * merged into the line.
   */
  linkExisting(): Promise<number> {
    return this.exclusive(async () => {
      let n = 0;
      for (const path of this.vault.markdownFiles()) {
        if (!this.isFileEligible(path)) continue;
        for (const { task } of findTasks(await this.vault.read(path))) {
          if (!task.todoistId) continue;
          const known = this.state.tasks[task.todoistId];
          if (known) {
            // Another line for a task already linked from another note: a copy.
            if (known.path !== path && !known.copies?.includes(path)) known.copies = [...(known.copies ?? []), path];
            continue;
          }
          // The line's words are its title as synced (see withTitle), not references. Lines not
          // rewritten for deadlines yet still have the Todoist date as `📅` (see readLine).
          const base: TaskFields = { text: task.content, checked: task.checked, due: task.due };
          if (!this.state.datesMigrated) base.due = task.due ?? task.deadline ?? null;
          else base.deadline = task.deadline ?? null;
          this.state.tasks[task.todoistId] = { path, base, ...(task.fields?.onCompletion === "delete" ? { deleteOnDone: true } : {}) };
          n++;
        }
      }
      if (n) await this.save();
      return n;
    });
  }

  // ---------------------------------------------------------------- import

  /** Whether a Todoist task is already linked to a line in the vault. */
  isLinked(id: string): boolean {
    const rec = this.state.tasks[id];
    return !!rec && !rec.orphaned;
  }

  /**
   * All open Todoist tasks, for the import picker. A full read that leaves the sync token alone,
   * so the next pull still sees everything changed since the last one.
   */
  openTasks(): Promise<TodoistItem[]> {
    return this.exclusive(async () => {
      const res = await this.client.sync({ syncToken: "*", resourceTypes: ["items"] });
      // A full read of the items, so the subtask counts can be refreshed from it.
      this.state.subtasks = {};
      this.noteSubtasks(res.items ?? []);
      return (res.items ?? []).filter((i) => !i.is_deleted && !i.checked);
    });
  }

  /**
   * Link tasks imported into `path`, given their lines as written (see importLines). Called before
   * the lines reach the note, so a push or pull that runs first sees them as synced, not new.
   */
  registerImport(path: string, imported: { item: TodoistItem; line: string }[]): Promise<void> {
    return this.exclusive(async () => {
      for (const { item, line } of imported) {
        const parsed = parseTaskLine(line);
        if (!parsed) continue;
        this.state.tasks[item.id] = { path, base: { ...this.localFields(parsed), text: parsed.content, checked: false } };
        this.state.remote[item.id] = {
          projectId: item.project_id,
          priority: item.priority,
          due: dueDate(item.due),
          deadline: item.deadline?.date ?? null,
          dueString: item.due?.string,
          recurring: item.due?.is_recurring,
          checked: false,
          labels: item.labels,
          parentId: item.parent_id ?? null,
          orderKey: item.order_key ?? null,
          childOrder: item.child_order,
        };
      }
      this.log(`${path}: imported ${imported.length} task(s) from Todoist`);
      await this.save();
    });
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
    let tidied = 0;
    let repeated = new Set<string>();
    await this.vault.process(path, (content) => {
      const lines = content.split("\n");
      const all = findTasks(content);
      repeated = this.unlinkRepeated(lines, all);
      for (const found of all) {
        const { line } = found;
        let task = found.task;
        if (task.todoistId && repeated.has(task.todoistId) && task.checked) continue; // unlinked above
        const next = line === opts.skipLine ? null : this.tidy(lines[line], task);
        if (next) {
          task = next;
          lines[line] = serializeTask(next);
          tidied++;
        }
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
      return newUuids.length || tidied || repeated.size ? lines.join("\n") : content;
    });
    if (tidied) this.log(`${path}: rewrote ${tidied} line(s) for the Tasks plugin`);
    if (repeated.size) this.log(`${path}: ${repeated.size} repeating task(s) ticked with the Tasks plugin`);
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
    /** References this push applied to synced tasks, by task id, to remove from their lines. */
    const applied = new Map<string, AppliedRefs>();
    const markApplied = (id: string, refs: AppliedRefs) => applied.set(id, { ...applied.get(id), ...refs });
    /** Projects created by this push: temp id → lower-cased name. */
    const newProjects = new Map<string, string>();

    /** Project id for a `#[Name]` reference, queueing a `project_add` if it doesn't exist yet. */
    const projectTarget = (name: string): string | undefined => {
      const existing = this.findProject(name);
      if (existing) return existing;
      // A path, `Work/Clients/Acme`: each project in it that doesn't exist yet is created, under
      // the one before it. Its first name can be an existing project at any level.
      const parts = splitProjectPath(name);
      let parent: string | undefined;
      for (let i = 0; i < parts.length; i++) {
        const found = i === 0 ? this.findProject(parts[0]) : parent && !newProjects.has(parent) ? childProject(this.state, parent, parts[i]) : undefined;
        if (found) {
          parent = found;
          continue;
        }
        const key = projectKey(parts.slice(0, i + 1).join("/"));
        const queued = [...newProjects].find(([, k]) => k === key)?.[0];
        if (queued) {
          parent = queued;
          continue;
        }
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
        const args: Record<string, unknown> = { name: parts[i] };
        if (parent) args.parent_id = parent;
        commands.push({ type: "project_add", uuid: tmp, temp_id: tmp, args });
        parent = tmp;
      }
      return parent;
    };

    /** Labels created by this push: key → name as created. */
    const newLabels = new Map<string, string>();
    /**
     * Todoist names for `@label` references (an existing label's own spelling), queueing a
     * `label_add` for each new one. Undefined if a label is new and this device may not create.
     */
    const labelNames = (refs: string[]): string[] | undefined => {
      const out: string[] = [];
      for (const ref of refs) {
        const existing = this.findLabel(ref);
        if (existing) {
          out.push(existing);
          continue;
        }
        const key = labelKey(ref);
        const name = newLabels.get(key) ?? ref.trim().replace(/\s+/g, " ");
        if (!newLabels.has(key)) {
          if (!canCreate) return undefined; // hold; a device that may create will apply it
          newLabels.set(key, name);
          const tmp = makeUuid();
          const cmd: Command = { type: "label_add", uuid: tmp, temp_id: tmp, args: { name } };
          commands.push(cmd);
          // Known from now on, so a retry or the next line doesn't create it again. The next pull
          // replaces this entry with the real one.
          onOk[cmd.uuid] = () => (this.state.labels[`${NEW_LABEL}${key}`] = { name });
        }
        out.push(name);
      }
      return out;
    };

    const lines = content.split("\n");
    const byLine = new Map(tasks.map((t) => [t.line, t.task]));
    /** Each synced task's lines in this note: more than one if it's copied within the note. */
    const linesOf = new Map<string, ParsedTask[]>();
    for (const { task } of tasks) if (task.todoistId) linesOf.set(task.todoistId, [...(linesOf.get(task.todoistId) ?? []), task]);
    /** Tasks whose fields this push changed in Todoist: written to their other lines after. */
    const spread = new Map<string, string>(); // id → title before the push
    const taskLines = new Set(byLine.keys());
    /** Creates sent by this push: pending uuid → project id sent (undefined: the Inbox). */
    const sentCreates = new Map<string, string | undefined>();
    /** Creates of subtasks whose project this device doesn't know; a pull fills in their chip. */
    const unknownProject = new Set<string>();
    /** Each create's line, nested under which task (id or temp id) in the note, or null. */
    const createdUnder = new Map<string, string | null>();
    /** Nested lines with a `#[Project]`: top-level tasks in that project, so moved out of their block. */
    const outdentNew = new Set<string>();
    const outdent = new Set<string>();

    /**
     * The Todoist parent for a new line nested under another checkbox: its task id, or the temp id
     * of its create in this push, with its project (null if unknown). "wait" if the parent isn't
     * created yet; null for a line that isn't nested under a synced or syncing task.
     */
    const parentFor = (line: number): { id: string; projectId: string | null | undefined } | "wait" | null => {
      const p = parentLine(lines, line, taskLines);
      if (p === null) return null;
      const pt = byLine.get(p)!;
      if (pt.todoistId) {
        if (this.state.tasks[pt.todoistId]?.orphaned) return null;
        const meta = this.state.remote[pt.todoistId];
        return { id: pt.todoistId, projectId: meta ? meta.projectId : null };
      }
      if (pt.pendingUuid) {
        return sentCreates.has(pt.pendingUuid) ? { id: pt.pendingUuid, projectId: sentCreates.get(pt.pendingUuid) } : "wait";
      }
      return this.wantsCreate(pt) ? "wait" : null;
    };

    for (const { line, task: parsed } of tasks) {
      let task = parsed;
      let local = this.localFields(task);

      if (task.pendingUuid) {
        const pend = this.state.pending[task.pendingUuid];
        if (!pend) continue; // created by another device; it will resolve the marker
        pend.path = path;
        const args: Record<string, unknown> = {
          content: task.text,
          description: this.backlink(path, task.pendingUuid),
        };
        // Nested under a task: a subtask, in its parent's project. A `#[Project]` reference wins,
        // since a subtask can't be in another project than its parent: it's created as a
        // top-level task there, and its line is moved out of the block to match.
        const placed = parentFor(line);
        if (placed === "wait" && !task.projectRef) {
          deferred = true; // created once its parent is, so it isn't made a task of its own
          continue;
        }
        const parent = task.projectRef || placed === "wait" ? null : placed;
        if (task.projectRef && placed) outdentNew.add(task.pendingUuid);
        createdUnder.set(task.pendingUuid, parent ? parent.id : null);
        if (parent) {
          args.parent_id = parent.id;
          if (parent.projectId) args.project_id = parent.projectId;
          else if (parent.projectId === null) unknownProject.add(task.pendingUuid);
        } else {
          const projectId = task.projectRef ? projectTarget(task.projectRef) : this.projectIdFor(path);
          if (task.projectRef && !projectId) continue; // project can't be created on this device
          if (projectId) args.project_id = projectId;
        }
        if (task.labelRefs.length) {
          const labels = labelNames(task.labelRefs);
          if (!labels) continue; // a label can't be created on this device
          args.labels = labels;
        }
        const priority = task.priorityRef ?? (this.tasksFields() ? linePriority(task) : null);
        if (priority && priority !== 4) args.priority = toApiPriority(priority);
        else if (task.priorityRef) args.priority = toApiPriority(task.priorityRef);
        // Due date in words: Todoist works it out, and the next pull writes it to the line.
        const rule = this.tasksFields() && task.fields?.recurrence ? canonicalRule(task.fields.recurrence) : undefined;
        if (task.dueRef) args.due = dueFromWords(task.dueRef);
        else if (rule) args.due = { string: todoistRule(rule), ...(task.due ? { date: task.due } : {}), lang: "en" };
        else if (task.due) args.due = { date: task.due };
        if (task.deadline) args.deadline = { date: task.deadline };
        // Same uuid on retry: Todoist de-duplicates commands it has already applied.
        commands.push({ type: "item_add", uuid: task.pendingUuid, temp_id: task.pendingUuid, args });
        sentCreates.set(task.pendingUuid, args.project_id as string | undefined);
        continue;
      }

      if (!task.todoistId) continue;
      const id = task.todoistId;
      // The same task on another line of this note: a copy. The first line carries its references;
      // every line's fields count (see combinedLocal), and are sent once, with the first.
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      let rec = this.state.tasks[id];
      let adopted = false;
      if (!rec) {
        // Marker appeared here without a record (pasted from another note, or created elsewhere):
        // adopt it, taking the line's words as its title, since they came from a synced line.
        rec = this.state.tasks[id] = { path, base: { ...local, text: parsed.content } };
        adopted = true;
      }
      // In a note other than its home: a copy, or the task moved here if its home no longer has it.
      if (rec.path !== path) await this.placeLine(rec, id, path);
      const home = rec.path === path;
      delete rec.gone;
      if (rec.orphaned) continue;
      if (home) {
        if (parsed.fields?.onCompletion === "delete") rec.deleteOnDone = true;
        else delete rec.deleteOnDone;
      }
      // Words of the synced title are title, not references (see withTitle).
      task = this.readLine(parsed, rec);
      const r0 = rec;
      local = this.combinedLocal((linesOf.get(id) ?? [parsed]).map((t) => this.readLine(t, r0)), rec);

      // `#[Project]` on a synced task: move it, then strip the reference. Not while the line is being edited.
      if (task.projectRef) {
        if (line === opts.skipLine) {
          deferred = true;
        } else {
          const target = projectTarget(task.projectRef);
          if (target && target === this.state.remote[id]?.projectId) {
            markApplied(id, { project: true }); // already there
          } else if (target) {
            const cmd: Command = { type: "item_move", uuid: makeUuid(), args: { id, project_id: target } };
            commands.push(cmd);
            // Moving to a project makes it a top-level task there, so a nested line moves out of its block.
            const nested = home && parentFor(line) !== null;
            const r = rec;
            onOk[cmd.uuid] = () => {
              markApplied(id, { project: true });
              if (nested) {
                outdent.add(id);
                r.parent = null;
              }
            };
          }
        }
      }
      // `@labels` on a synced task: add them to its labels, then strip them. Todoist only takes the
      // whole list, so this needs the task's current labels; without them, sending would drop some.
      const meta = this.state.remote[id];
      if (task.labelRefs.length) {
        if (line === opts.skipLine || !meta) {
          deferred = true; // being edited, or details not fetched yet (the next pull fetches them)
        } else {
          const names = labelNames(task.labelRefs);
          if (names) {
            const current = meta.labels ?? [];
            const merged = [...current];
            for (const n of names) if (!merged.some((c) => labelKey(c) === labelKey(n))) merged.push(n);
            const refs = task.labelRefs;
            if (merged.length === current.length) {
              markApplied(id, { labels: refs }); // already has them
            } else {
              const cmd: Command = { type: "item_update", uuid: makeUuid(), args: { id, labels: merged } };
              commands.push(cmd);
              onOk[cmd.uuid] = () => {
                meta.labels = merged;
                markApplied(id, { labels: refs });
              };
            }
          }
        }
      }
      // `p1`–`p4` on a synced task: set its priority, then strip it. Not while the line is being edited.
      if (task.priorityRef) {
        if (line === opts.skipLine) {
          deferred = true;
        } else {
          const ref = task.priorityRef;
          const priority = toApiPriority(ref);
          if (meta?.priority === priority) {
            markApplied(id, { priority: ref }); // already set
          } else {
            const cmd: Command = { type: "item_update", uuid: makeUuid(), args: { id, priority } };
            commands.push(cmd);
            onOk[cmd.uuid] = () => {
              if (meta) meta.priority = priority;
              markApplied(id, { priority: ref });
            };
          }
        }
      }
      // Due date in words on a synced task: send it to Todoist, then strip it. The pull that follows
      // writes the date Todoist worked out to the line as `⏳`. Not while the line is being edited.
      if (task.dueRef) {
        if (line === opts.skipLine) {
          deferred = true;
        } else {
          const ref = task.dueRef;
          const cmd: Command = { type: "item_update", uuid: makeUuid(), args: { id, due: dueFromWords(ref) } };
          commands.push(cmd);
          const lineDue = local.due;
          const lineRule = local.recurrence;
          onOk[cmd.uuid] = () => {
            markApplied(id, { due: ref });
            // The line's `⏳` and `🔁` are superseded: count them as synced, so the pull's replace them.
            rec!.base = { ...rec!.base, due: lineDue };
            if (lineRule !== undefined) rec!.base.recurrence = lineRule;
            this.wantPull = true;
          };
        }
      }
      // Nesting changed in the note since the last sync (indented, outdented or moved): make it a
      // subtask of the task it's now under, or a top-level task. Todoist moves a subtask's own
      // subtasks with it, and those lines moved with it here, so they stay put.
      const placed = home ? parentFor(line) : undefined;
      if (placed === undefined) {
        // A copy: its home note decides its nesting.
      } else if (placed === "wait" || (placed && sentCreates.has(placed.id))) {
        if (canCreate) deferred = true; // its new parent is being created; move it once it has an id
      } else {
        const want = placed ? placed.id : null;
        const r = rec;
        if (r.parent === undefined || adopted || task.projectRef || want === r.parent) {
          r.parent = want; // first seen, unchanged, or a `#[Project]` (which wins): just note it
        } else if (task.checked) {
          // A completed task isn't moved; the change applies if it's unticked.
        } else if (!meta || meta.parentId === undefined) {
          deferred = true; // its Todoist details are needed first; a pull brings them
        } else if (want === meta.parentId) {
          r.parent = want; // already so in Todoist
        } else {
          const args = want ? { id, parent_id: want } : { id, project_id: meta.projectId };
          const cmd: Command = { type: "item_move", uuid: makeUuid(), args };
          commands.push(cmd);
          onOk[cmd.uuid] = () => {
            r.parent = want;
            meta.parentId = want;
            this.state.subtasks ??= {};
            if (want) this.state.subtasks[id] = want;
            else delete this.state.subtasks[id];
            const parentProject = want ? this.state.remote[want]?.projectId : undefined;
            if (parentProject) meta.projectId = parentProject; // a subtask is in its parent's project
          };
        }
      }

      if (adopted) continue;

      const { push } = merge(rec.base, local, rec.base, 0, 0);
      // Words beat an edited `⏳` or `🔁` on the same line; they're the newer intent.
      if (task.dueRef && line !== opts.skipLine) {
        delete push.due;
        delete push.recurrence;
      }
      const synced: TaskFields = { ...rec.base, ...pickFields(local, push) };
      const due = this.dueArg(id, synced);
      if (repeated.has(id) && due && "string" in due) {
        // Ticked with Tasks: complete this occurrence in Todoist, moving it to the next one on the
        // line, rather than closing it (Todoist would work out its own next date).
        const r = rec;
        const cmd: Command = { type: "item_update_date_complete", uuid: makeUuid(), args: { id, due, is_forward: 1 } };
        commands.push(cmd);
        const done = pickFields(local, { due: null, ...("recurrence" in push ? { recurrence: null } : {}) });
        onOk[cmd.uuid] = () => {
          if (!spread.has(id)) spread.set(id, r.base.text);
          r.base = { ...r.base, ...done };
        };
        delete push.due;
        delete push.recurrence;
      }
      if (isEmpty(push)) continue;
      for (const cmd of commandsFor(id, push, due)) {
        commands.push(cmd);
        onOk[cmd.uuid] = () => {
          if (!spread.has(id)) spread.set(id, rec!.base.text);
          rec!.base = { ...rec!.base, ...pickFields(local, push) };
          if (cmd.type === "item_update" && push.priority !== undefined && meta) meta.priority = toApiPriority(push.priority);
          // A subtask ticked or unticked here: its parent's count changes now, not at the next pull.
          this.state.subtasks ??= {};
          if (cmd.type === "item_close") delete this.state.subtasks[id];
          else if (cmd.type === "item_uncomplete" && meta?.parentId) this.state.subtasks[id] = meta.parentId;
        };
      }
    }

    // Records for this file whose marker vanished: unlink (never delete in Todoist). A `🏁 delete`
    // line was most likely deleted by Tasks on completion: noted, for a pull to complete it.
    // A copy's marker gone from this note: just that copy is gone. Its home's: a copy becomes home.
    for (const [id, rec] of Object.entries(this.state.tasks)) {
      if (seenIds.has(id) || content.includes(`%%td:${id}%%`)) continue;
      if (rec.copies?.includes(path)) {
        this.dropCopy(rec, path);
        continue;
      }
      if (rec.path !== path || (await this.promoteCopy(rec, id))) continue;
      if (rec.deleteOnDone && !rec.orphaned && !rec.base.checked) rec.gone ??= Date.now();
      else delete this.state.tasks[id];
    }

    if (!commands.length) {
      await this.stripRefs(path, applied);
      await this.syncOrder(path);
      await this.save();
      return { deferred };
    }

    // 3. Send. Persist in-flight project creates first, so a crash mid-request is detected on restart.
    if (newProjects.size) await this.save();
    const mapping: Record<string, string> = {};
    for (let i = 0; i < commands.length; i += BATCH) {
      const batch = commands.slice(i, i + BATCH);
      // A project or parent task created in an earlier batch is referenced by its real id from here on.
      for (const cmd of batch) {
        for (const key of ["project_id", "parent_id"]) {
          const ref = cmd.args[key];
          if (typeof ref === "string" && mapping[ref]) cmd.args[key] = mapping[ref];
        }
      }
      const res = await this.client.sync({ commands: batch });
      Object.assign(mapping, res.temp_id_mapping ?? {});
      for (const cmd of batch) {
        const status = res.sync_status?.[cmd.uuid];
        if (status === "ok") onOk[cmd.uuid]?.();
        else if (status) {
          const extra = status.error_extra ? ` ${JSON.stringify(status.error_extra)}` : "";
          this.log(`Todoist rejected ${cmd.type} ${JSON.stringify(cmd.args)}: ${status.error}${extra}`);
        }
      }
    }

    // New projects: record them so chips and later references resolve without waiting for a pull.
    for (const [tmp, key] of newProjects) {
      const realId = mapping[tmp];
      if (!realId) continue; // de-duplicated retry; the next pull brings the project in
      const cmd = commands.find((c) => c.uuid === tmp)!;
      const parent = cmd.args.parent_id as string | undefined;
      this.state.projects[realId] = { name: cmd.args.name as string, parentId: parent ? (mapping[parent] ?? parent) : null };
      delete this.state.pendingProjects[key];
    }
    for (const cmd of commands) {
      if (cmd.type !== "item_move" || !applied.get(cmd.args.id as string)?.project) continue;
      const meta = this.state.remote[cmd.args.id as string];
      const pid = cmd.args.project_id as string;
      if (meta) {
        meta.projectId = mapping[pid] ?? pid;
        meta.parentId = null; // moving to a project puts it at the top level
      }
    }

    // 4. Replace pending markers with real ids, and strip project references that have been applied.
    this.log(`${path}: sent ${commands.map((c) => c.type).join(", ")}`);
    const resolved = Object.entries(mapping).filter(([tmp]) => this.state.pending[tmp]);
    if (resolved.length) await this.resolvePending(path, resolved);
    // Chip details for the new tasks, from what we sent, so they needn't be fetched.
    const inbox = Object.entries(this.state.projects).find(([, p]) => p.inbox)?.[0];
    for (const [tmp, realId] of resolved) {
      const cmd = commands.find((c) => c.uuid === tmp && c.type === "item_add");
      if ((cmd?.args.due as { string?: string } | undefined)?.string) this.wantPull = true; // fetch the date
      const rec = this.state.tasks[realId];
      if (!cmd || !rec) continue;
      const parent = cmd.args.parent_id as string | undefined;
      const parentId = parent ? (mapping[parent] ?? parent) : null;
      if (parentId) (this.state.subtasks ??= {})[realId] = parentId; // its parent's chip counts it now
      // Its nesting in the note when created, so a later indent or outdent is seen as a change.
      const under = createdUnder.get(tmp);
      if (rec.parent === undefined) rec.parent = under ? (mapping[under] ?? under) : null;
      const pid = cmd.args.project_id as string | undefined;
      const projectId = pid ? (mapping[pid] ?? pid) : inbox;
      if (!projectId || unknownProject.has(tmp) || this.state.remote[realId]) continue;
      const due = cmd.args.due as { date: string } | undefined;
      const deadline = cmd.args.deadline as { date: string } | undefined;
      const labels = (cmd.args.labels as string[] | undefined) ?? [];
      const priority = (cmd.args.priority as number | undefined) ?? 1;
      this.state.remote[realId] = { projectId, priority, due: due?.date ?? null, deadline: deadline?.date ?? null, checked: false, labels, parentId };
    }
    await this.stripRefs(path, applied);
    for (const [tmp, realId] of resolved) if (outdentNew.has(tmp)) outdent.add(realId);
    if (outdent.size) await this.moveOut(path, [...outdent]);
    // What this push changed, written to the task's other lines, here and in other notes.
    if (spread.size) {
      const targets = new Map<string, LineTarget>();
      for (const [id, title] of spread) {
        const rec = this.state.tasks[id];
        if (rec) targets.set(id, { fields: rec.base, title });
      }
      const paths = [...targets.keys()].flatMap((id) => this.locations(this.state.tasks[id]));
      await this.writeLines(targets, paths, opts.skipLine === undefined ? undefined : { path, line: opts.skipLine });
    }
    await this.syncOrder(path);

    await this.save();
    return { deferred };
  }

  /**
   * Move these tasks' lines, with what's nested under them, out of the block they're in to the
   * top level, just after it: they've become top-level tasks in Todoist (filed in another project).
   */
  private async moveOut(path: string, ids: string[]): Promise<void> {
    const idOf = (l: string) => parseTaskLine(l)?.todoistId ?? null;
    const tab = this.settings().indent ?? "\t";
    await this.vault.process(path, (content) => {
      let ls = content.split("\n");
      let changed = false;
      for (const id of ids) {
        const at = findLineByMarker(ls, id);
        const next = at >= 0 ? moveBlock(ls, at, null, new Set(), tab, idOf) : null;
        if (!next) continue;
        ls = next;
        changed = true;
        const rec = this.state.tasks[id];
        if (rec) rec.parent = null;
        this.log(`${path}: moved "${rec?.base.text ?? id}" out of its block, as it's now a top-level task in another project`);
      }
      return changed ? ls.join("\n") : content;
    });
  }

  /**
   * Remove references this push applied from their synced lines. Labels, priority and due date
   * are removed only if still what was applied, in case something else was typed meanwhile.
   */
  private async stripRefs(path: string, applied: Map<string, AppliedRefs>): Promise<void> {
    if (!applied.size) return;
    await this.vault.process(path, (content) => {
      const lines = content.split("\n");
      let changed = false;
      for (const [id, a] of applied) {
        const idx = findLineByMarker(lines, id);
        const parsed = idx >= 0 ? parseTaskLine(lines[idx]) : null;
        if (!parsed) continue;
        const task = withTitle(parsed, this.state.tasks[id]?.base.text);
        const appliedLabels = new Set((a.labels ?? []).map(labelKey));
        const labelRefs = task.labelRefs.filter((l) => !appliedLabels.has(labelKey(l)));
        const projectRef = a.project ? null : task.projectRef;
        const priorityRef = a.priority === task.priorityRef ? null : task.priorityRef;
        const dueRef = a.due === task.dueRef ? null : task.dueRef;
        if (
          projectRef === task.projectRef &&
          labelRefs.length === task.labelRefs.length &&
          priorityRef === task.priorityRef &&
          dueRef === task.dueRef
        ) {
          continue;
        }
        lines[idx] = serializeTask({ ...task, projectRef, labelRefs, priorityRef, dueRef });
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
        // The create carried the line's references, so they've done their job. With Tasks fields
        // written, the priority it was created with stays on the line as a Tasks priority.
        const fields = this.tasksFields() && task.priorityRef ? withLinePriority(task.fields, task.priorityRef) : task.fields;
        const created = { ...task, pendingUuid: null, todoistId: realId, projectRef: null, labelRefs: [], priorityRef: null, dueRef: null, fields };
        lines[idx] = serializeTask(created);
        this.state.tasks[realId] = { path, base: this.localFields(created) };
        if (fields?.onCompletion === "delete") this.state.tasks[realId].deleteOnDone = true;
      }
      return lines.join("\n");
    });
  }

  // ---------------------------------------------------------------- pull

  /**
   * True (once) if a push since the last call sent something that only a pull completes, such as
   * a due date in words, whose actual date Todoist works out. The caller should pull soon.
   */
  takePullRequest(): boolean {
    const want = this.wantPull;
    this.wantPull = false;
    return want;
  }

  pull(): Promise<void> {
    return this.exclusive(() => this.pullInner());
  }

  /**
   * Add and remove labels on a synced task, from the label picker. Pulls first, so the change is
   * made to the task's labels as Todoist has them now: Todoist only takes the whole list, and one
   * added or removed there since this device last pulled would otherwise be undone. A label that
   * doesn't exist is created. Returns false if the task isn't one this device can change.
   */
  /**
   * Set a synced task's due date, from the due date picker: a date (`YYYY-MM-DD`), words for
   * Todoist to work out (`next friday`, `every month`), or null for none. Then pulls, so the line's
   * `⏳` follows the way any change made in Todoist does. Throws if Todoist can't read the words.
   */
  async changeDue(id: string, due: { date: string } | { words: string } | null): Promise<boolean> {
    const sent = await this.exclusive(async () => {
      if (!this.isLinked(id)) return false;
      const value = due === null ? null : "words" in due ? dueFromWords(due.words) : { date: due.date };
      const cmd: Command = { type: "item_update", uuid: makeUuid(), args: { id, due: value } };
      const res = await this.client.sync({ commands: [cmd] });
      const status = res.sync_status?.[cmd.uuid];
      if (status !== "ok") {
        const why = status && typeof status === "object" ? status.error : "no answer";
        throw new Error(due && "words" in due ? `Todoist couldn't set the date to “${due.words}”: ${why}` : `Todoist didn't change the date: ${why}`);
      }
      this.log(`set due on ${id}: ${due === null ? "none" : "words" in due ? due.words : due.date}`);
      return true;
    });
    if (sent) await this.pull();
    return sent;
  }

  async changeLabels(id: string, add: string[], remove: string[]): Promise<boolean> {
    await this.pull();
    return this.exclusive(async () => {
      const meta = this.state.remote[id];
      if (!meta || !this.state.tasks[id] || this.state.tasks[id].orphaned) return false;
      const current = meta.labels ?? [];
      const drop = new Set(remove.map(labelKey));
      const next = current.filter((l) => !drop.has(labelKey(l)));
      const commands: Command[] = [];
      const created = new Map<string, string>(); // command uuid → label name
      for (const ref of add) {
        if (next.some((l) => labelKey(l) === labelKey(ref))) continue;
        const existing = this.findLabel(ref);
        const name = existing ?? ref.trim().replace(/\s+/g, " ");
        if (!name) continue;
        if (!existing && ![...created.values()].some((n) => labelKey(n) === labelKey(name))) {
          const tmp = makeUuid();
          commands.push({ type: "label_add", uuid: tmp, temp_id: tmp, args: { name } });
          created.set(tmp, name);
        }
        next.push(name);
      }
      const same = next.length === current.length && next.every((l, i) => l === current[i]);
      if (same) return true;
      const update: Command = { type: "item_update", uuid: makeUuid(), args: { id, labels: next } };
      commands.push(update);
      const res = await this.client.sync({ commands });
      for (const [uuid, name] of created) {
        if (res.sync_status?.[uuid] === "ok") this.state.labels[`${NEW_LABEL}${labelKey(name)}`] = { name };
      }
      const status = res.sync_status?.[update.uuid];
      if (status !== "ok") {
        const why = status && typeof status === "object" ? status.error : "no answer";
        throw new Error(`Todoist didn't change the labels: ${why}`);
      }
      meta.labels = next;
      this.log(`changed labels on ${id}: ${next.length ? next.map((l) => `@${l}`).join(" ") : "none"}`);
      await this.save();
      return true;
    });
  }

  /**
   * Linked tasks this device has no Todoist details for (project, due date, ...), and hasn't yet
   * tried to fetch. Happens when a task was created on another device: its marker arrives here by
   * Obsidian Sync after this device's pulls have already gone past the task. Also tasks whose
   * details were saved before their parent task was tracked, which moving them needs.
   */
  missingDetails(): string[] {
    return Object.entries(this.state.tasks)
      .filter(([id, rec]) => !rec.orphaned && this.state.remote[id]?.parentId === undefined && !this.fetchTried.has(id))
      .map(([id]) => id);
  }

  /**
   * Complete the Todoist tasks of `🏁 delete` lines gone for a while (see TaskRecord.gone): Tasks
   * deletes such a line when it's completed. One found in another note was moved, not deleted,
   * and is left linked there.
   */
  private async completeDeleted(): Promise<void> {
    const gone = Object.entries(this.state.tasks).filter(([, r]) => r.gone && Date.now() - r.gone >= GONE_GRACE_MS);
    if (!gone.length) return;
    const files = this.vault.markdownFiles();
    const commands: Command[] = [];
    for (const [id, rec] of gone) {
      let found: string | undefined;
      for (const f of files) {
        if ((await this.vault.read(f)).includes(`%%td:${id}%%`)) {
          found = f;
          break;
        }
      }
      if (found) {
        rec.path = found;
        this.dropCopy(rec, found);
        delete rec.gone;
      } else {
        commands.push({ type: "item_close", uuid: makeUuid(), args: { id } });
      }
    }
    if (commands.length) {
      const res = await this.client.sync({ commands });
      for (const cmd of commands) {
        const id = cmd.args.id as string;
        if (res.sync_status?.[cmd.uuid] !== "ok") continue; // tried again at the next pull
        delete this.state.tasks[id];
        this.log(`completed ${id}: its 🏁 delete line was removed`);
      }
    }
    await this.save();
  }

  private async pullInner(): Promise<void> {
    await this.completeDeleted();
    // Projects saved before archived/parent/order were tracked need one full sync to fill them in, and
    // so do tasks we have no details for, since an incremental sync only returns tasks that changed.
    const stale =
      Object.values(this.state.projects).some((p) => p.parentId === undefined || p.order === undefined) ||
      !this.state.labelsSynced ||
      !this.state.subtasksSynced ||
      (this.tasksFields() && (!this.state.tasksFieldsSynced || !this.state.repeatsSynced)) ||
      (!!this.state.datesMigrated && !this.state.deadlinesSynced);
    const missing = this.missingDetails();
    // Tried once per session: a completed or deleted task isn't returned, and mustn't force a full sync every time.
    for (const id of missing) this.fetchTried.add(id);
    if (missing.length) this.log(`fetching details for ${missing.length} task(s) linked elsewhere`);
    const res = await this.client.sync({
      syncToken: stale || missing.length ? "*" : (this.state.syncToken ?? "*"),
      resourceTypes: ["items", "projects", "labels"],
    });

    if (res.full_sync) {
      this.state.projects = {};
      this.state.labels = {};
      this.state.labelsSynced = true;
      this.state.subtasks = {};
      this.state.subtasksSynced = true;
    }
    // Turned on: a full sync writes every task's priority to its line. Turned off: the next time it's
    // turned on needs one again.
    this.state.tasksFieldsSynced = this.tasksFields() && (res.full_sync || !!this.state.tasksFieldsSynced);
    // Likewise each repeating task's `🔁`, which this version is the first to write.
    this.state.repeatsSynced = this.tasksFields() && (res.full_sync || !!this.state.repeatsSynced);
    // Lines rewritten for deadlines: a full sync brings every task's deadline to its line.
    if (res.full_sync && this.state.datesMigrated) this.state.deadlinesSynced = true;
    this.noteSubtasks(res.items ?? []);
    for (const l of res.labels ?? []) {
      if (l.is_deleted) delete this.state.labels[l.id];
      else this.state.labels[l.id] = { name: l.name, order: l.item_order };
    }
    // Labels this device just created are now known by their real id (or turned out not to exist).
    for (const id of Object.keys(this.state.labels)) if (id.startsWith(NEW_LABEL)) delete this.state.labels[id];
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
          order: p.child_order ?? 0,
        };
      }
    }
    // Any unconfirmed project create has now either arrived above or never happened.
    this.state.pendingProjects = {};

    /** Linked tasks that changed, by home note. */
    const byPath = new Map<string, TodoistItem[]>();
    const changed: TodoistItem[] = [];
    const pendingResolutions = new Map<string, [string, string][]>();
    /** Linked tasks moved to another parent in Todoist, by note. */
    const movedHere = new Map<string, string[]>();

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
      // Moved to another parent (or out to the top level) in Todoist since we last saw it.
      const was = this.state.remote[item.id]?.parentId;
      if (was !== undefined && was !== (item.parent_id ?? null) && !item.checked) {
        movedHere.set(rec.path, [...(movedHere.get(rec.path) ?? []), item.id]);
      }
      this.state.remote[item.id] = {
        projectId: item.project_id,
        priority: item.priority,
        due: dueDate(item.due),
        deadline: item.deadline?.date ?? null,
        dueString: item.due?.string,
        recurring: item.due?.is_recurring,
        checked: item.checked,
        labels: item.labels,
        parentId: item.parent_id ?? null,
        orderKey: item.order_key ?? null,
        childOrder: item.child_order,
      };
      byPath.set(rec.path, [...(byPath.get(rec.path) ?? []), item]);
      changed.push(item);
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

    const commands = await this.mergeItems(changed);
    if (commands.length) await this.client.sync({ commands });
    // Tasks moved to another parent in Todoist: move their lines to match.
    for (const [path, ids] of movedHere) await this.followMoves(path, ids);
    // Subtasks reordered in Todoist (or here, and not yet sent) in the notes this pull touched.
    for (const path of byPath.keys()) await this.syncOrder(path);
    this.state.syncToken = res.sync_token;
    await this.save();
  }

  // ---------------------------------------------------------------- nesting from Todoist

  /**
   * Tasks in `path` that were moved to another parent in Todoist (or out to the top level): move
   * their lines, with what's nested under them, to match. Not if the line's nesting was also
   * changed in the note since the last sync; the note wins, and the push sends its version.
   */
  private async followMoves(path: string, ids: string[]): Promise<void> {
    const idOf = (l: string) => parseTaskLine(l)?.todoistId ?? null;
    const tab = this.settings().indent ?? "\t";
    const sibling = (id: string): Sibling => ({ id, key: this.state.remote[id]?.orderKey, childOrder: this.state.remote[id]?.childOrder });
    const notes: string[] = [];
    await this.vault.process(path, (content) => {
      let ls = content.split("\n");
      let changed = false;
      for (const id of ids) {
        const rec = this.state.tasks[id];
        const want = this.state.remote[id]?.parentId ?? null;
        const at = findLineByMarker(ls, id);
        if (!rec || rec.orphaned || at < 0) continue;
        const taskLines = new Set(findTasks(ls.join("\n")).map((t) => t.line));
        const p = parentLine(ls, at, taskLines);
        const local = p === null ? null : idOf(ls[p]);
        if (local === want) {
          rec.parent = want;
          continue;
        }
        if (rec.parent !== undefined && local !== rec.parent) continue; // moved in the note too: the note wins
        if (want && findLineByMarker(ls, want) < 0) {
          notes.push(`${path}: "${rec.base.text}" was moved in Todoist under a task that isn't in this note; left where it is`);
          continue;
        }
        // Placed by Todoist's order among the new parent's subtasks that are in the note.
        const before = new Set(
          Object.entries(this.state.remote)
            .filter(([k, m]) => k !== id && m.parentId === want && compareSiblings(sibling(k), sibling(id)) < 0)
            .map(([k]) => k),
        );
        const next = moveBlock(ls, at, want, before, tab, idOf);
        if (!next) continue;
        ls = next;
        rec.parent = want;
        changed = true;
        notes.push(`${path}: moved "${rec.base.text}" to match Todoist`);
      }
      return changed ? ls.join("\n") : content;
    });
    for (const n of notes) this.log(n);
  }

  // ---------------------------------------------------------------- subtask order

  /**
   * Keep the order of each synced task's synced subtasks the same in the note and in Todoist
   * (see TaskRecord.kidsNote). Called after a push, and by a pull for the notes it touched.
   */
  private async syncOrder(path: string): Promise<void> {
    const lines = (await this.vault.read(path)).split("\n");
    const tasks = findTasks(lines.join("\n"));
    const byLine = new Map(tasks.map((t) => [t.line, t.task]));
    const taskLines = new Set(byLine.keys());
    const live = (id: string | null | undefined): id is string => !!id && this.isLinked(id);

    // Each synced task's open, synced subtasks in this note, in note order. Only those Todoist
    // agrees are its subtasks: one just indented under it is moved first, then ordered.
    // Only tasks at home here, on their first line: a copy's nesting is its own (see TaskRecord.path).
    const firstLine = new Map<string, number>();
    for (const { line, task } of tasks) if (task.todoistId && !firstLine.has(task.todoistId)) firstLine.set(task.todoistId, line);
    const atHome = (id: string, line: number) => this.state.tasks[id]?.path === path && firstLine.get(id) === line;
    const groups = new Map<string, string[]>();
    for (const { line, task } of tasks) {
      const id = task.todoistId;
      if (!live(id) || !atHome(id, line) || task.checked || this.state.remote[id]?.checked) continue;
      const p = parentLine(lines, line, taskLines);
      const parent = p === null ? null : byLine.get(p)?.todoistId;
      if (!live(parent) || !atHome(parent, p!) || this.state.remote[id]?.parentId !== parent) continue;
      groups.set(parent, [...(groups.get(parent) ?? []), id]);
    }
    if (!groups.size) return;

    // Tasks whose place in Todoist isn't known (created here, or saved by an older version): read it.
    let fresh: TodoistItem[] | undefined;
    const read = async () => (fresh ??= await this.readItems());
    const unknown = [...groups.values()].flat().filter((id) => this.state.remote[id]?.orderKey === undefined);
    if (unknown.some((id) => !this.orderTried.has(id))) {
      for (const id of unknown) this.orderTried.add(id);
      await read();
    }
    const sibling = (id: string): Sibling => ({ id, key: this.state.remote[id]?.orderKey, childOrder: this.state.remote[id]?.childOrder });
    const known = (id: string) => this.state.remote[id]?.orderKey !== undefined;

    const commands: Command[] = [];
    const onOk: Record<string, () => void> = {};
    const reorder = new Map<string, string[]>();
    for (const [parent, local] of groups) {
      const rec = this.state.tasks[parent];
      const remote = local.every(known) ? [...local].sort((a, b) => compareSiblings(sibling(a), sibling(b))) : null;
      const settle = (order: string[], todoist: string[] | null = order) => {
        rec.kidsNote = order;
        rec.kidsTodoist = todoist ?? undefined;
      };
      if (!rec.kidsNote) {
        settle(local, remote); // first seen: nothing to compare with yet
        continue;
      }
      const changed = (now: string[], was: string[] | undefined) =>
        !was || now.some((id) => !was.includes(id)) || !sameOrder(inOrderOf(now, was), inOrderOf(was, now));
      const noteChanged = changed(local, rec.kidsNote);
      const todoistChanged = !!remote && !!rec.kidsTodoist && !sameOrder(inOrderOf(remote, rec.kidsTodoist), inOrderOf(rec.kidsTodoist, remote));
      if (remote && sameOrder(local, remote)) {
        settle(local);
      } else if (noteChanged) {
        // Reordered in the note (or a subtask joined here): give the moved tasks new places.
        const siblings = (await read())
          .filter((i) => i.parent_id === parent && !i.checked && !i.is_deleted)
          .map((i) => ({ id: i.id, key: i.order_key, childOrder: i.child_order }))
          .sort(compareSiblings);
        const keys = reorderKeys(siblings, local);
        if (!keys) {
          this.log(`${path}: can't reorder the subtasks of ${parent} in Todoist (no order keys)`);
          settle(local, remote);
          continue;
        }
        for (const [id, key] of keys) {
          const cmd: Command = { type: "item_update", uuid: makeUuid(), args: { id, order_key: key } };
          commands.push(cmd);
          onOk[cmd.uuid] = () => {
            const meta = this.state.remote[id];
            if (meta) meta.orderKey = key;
          };
        }
        settle(local); // if a command fails, the next pull shows Todoist's order as changed and puts it back
      } else if (todoistChanged && remote) {
        reorder.set(parent, remote); // reordered in Todoist: rearrange the lines
      } else {
        settle(local, remote);
      }
    }

    if (commands.length) {
      const res = await this.client.sync({ commands });
      for (const cmd of commands) {
        const status = res.sync_status?.[cmd.uuid];
        if (status === "ok") onOk[cmd.uuid]?.();
        else if (status) this.log(`Todoist rejected ${cmd.type} ${JSON.stringify(cmd.args)}: ${status.error}`);
      }
      this.log(`${path}: reordered ${commands.length} subtask(s) in Todoist`);
    }
    if (reorder.size) {
      const idOf = (l: string) => parseTaskLine(l)?.todoistId ?? null;
      const done = new Set<string>();
      await this.vault.process(path, (content) => {
        let ls = content.split("\n");
        for (const [parent, order] of reorder) {
          const at = findLineByMarker(ls, parent);
          const next = at >= 0 ? reorderBlocks(ls, at, order, idOf) : null;
          if (next) {
            ls = next;
            done.add(parent);
          }
        }
        return done.size ? ls.join("\n") : content;
      });
      for (const [parent, order] of reorder) {
        const rec = this.state.tasks[parent];
        if (done.has(parent)) {
          rec.kidsNote = order;
          rec.kidsTodoist = order;
        } else {
          // Something other than subtasks sits among them, so there's no telling where it goes.
          this.log(`${path}: subtasks of ${parent} were reordered in Todoist; left as they are in the note`);
          rec.kidsTodoist = order;
        }
      }
      if (done.size) this.log(`${path}: reordered the subtasks of ${done.size} task(s) to match Todoist`);
    }
  }

  /** All open items, read afresh: fills in each linked task's place among its siblings. */
  private async readItems(): Promise<TodoistItem[]> {
    const res = await this.client.sync({ syncToken: "*", resourceTypes: ["items"] });
    const items = (res.items ?? []).filter((i) => !i.is_deleted && !i.checked);
    for (const i of items) {
      const meta = this.state.remote[i.id];
      if (!meta) continue;
      meta.orderKey = i.order_key ?? null;
      meta.childOrder = i.child_order;
      meta.parentId = i.parent_id ?? null;
    }
    return items;
  }

  /** Record which of these items are open subtasks, and of what (see SyncState.subtasks). */
  private noteSubtasks(items: TodoistItem[]): void {
    this.state.subtasks ??= {};
    for (const item of items) {
      if (item.parent_id && !item.checked && !item.is_deleted) this.state.subtasks[item.id] = item.parent_id;
      else delete this.state.subtasks[item.id];
    }
  }

  /**
   * Three-way merge each pulled task against its lines, in its home note and every copy, write the
   * result to each line that differs, and return the commands for what the notes changed. Between
   * copies changed differently, the most recently edited note wins (see combinedLocal).
   */
  private async mergeItems(items: TodoistItem[]): Promise<Command[]> {
    const commands: Command[] = [];
    const targets = new Map<string, LineTarget>();
    const paths: string[] = [];
    const contents = new Map<string, string>();
    for (const item of items) {
      const rec = this.state.tasks[item.id];
      const found: { task: ParsedTask; mtime: number; path: string }[] = [];
      for (const p of this.locations(rec)) {
        if (!contents.has(p)) contents.set(p, await this.readOrEmpty(p));
        const content = contents.get(p)!;
        const mtime = this.vault.mtime(p);
        for (const { task } of findTasks(content)) if (task.todoistId === item.id) found.push({ task: this.readLine(task, rec), mtime, path: p });
        paths.push(p);
      }
      if (!found.length) continue; // moved; the index will re-adopt it on the next push
      const home = found.find((f) => f.path === rec.path)?.task;
      found.sort((a, b) => b.mtime - a.mtime);
      const legacy = this.isLegacy(rec);
      const local = this.combinedLocal(found.map((f) => f.task), rec);
      const remote = this.remoteFields(item, legacy);
      const remoteAt = item.updated_at ? Date.parse(item.updated_at) : 0;
      const m = merge(rec.base, local, remote, found[0].mtime, remoteAt);
      if (m.conflicts.length) this.log(`Conflict on "${found[0].task.text}" (${m.conflicts.join(", ")}); resolved`);
      if (!isEmpty(m.push)) commands.push(...commandsFor(item.id, m.push, this.dueArg(item.id, m.merged)));
      // Lines from before deadlines synced, rewritten by this pull, get the date as `⏳`, so a `📅` is the
      // deadline from now on (see readLine).
      if (legacy && !isEmpty(m.pull)) m.merged.deadline = found[0].task.deadline ?? null;
      targets.set(item.id, { fields: m.merged, title: rec.base.text, completedAt: item.completed_at, legacy });
      if (home) this.noteHistory(item, rec, home, m.merged);
      rec.base = m.merged;
    }
    await this.writeLines(targets, paths);
    await this.checkHistory();
    return commands;
  }

  /**
   * This pull moves a repeating task's date on: note that its completions in Todoist are to be kept
   * as ticked lines (see history.ts). Only with Tasks fields written, and only when Todoist moved
   * the date: if the line did, as when Tasks ticked it, Tasks has already left its own.
   */
  private noteHistory(item: TodoistItem, rec: TaskRecord, home: ParsedTask, merged: TaskFields): void {
    const from = rec.base.due;
    const to = merged.due;
    if (!this.tasksFields() || !item.due?.is_recurring || !from || !to || to <= from || home.due !== from) return;
    const was = rec.historyDue;
    rec.historyDue = {
      from: was && was.from < from ? was.from : from,
      to,
      line: was && was.from < from ? was.line : serializeTask(withTitle(home, rec.base.text)),
      until: Date.now() + HISTORY_WAIT_MS,
    };
  }

  /**
   * Look for the completions in Todoist of repeating tasks it moved on, and keep each as a ticked
   * line. One not in the activity log yet is looked for again at the next pull, for a while.
   */
  private async checkHistory(): Promise<void> {
    for (const [id, rec] of Object.entries(this.state.tasks)) {
      const due = rec.historyDue;
      if (!due) continue;
      const line = parseTaskLine(due.line);
      if (!line || !this.tasksFields()) {
        delete rec.historyDue;
        continue;
      }
      let events: CompletionEvent[];
      try {
        const res = await this.client.get<{ results?: CompletionEvent[] }>("activities", {
          object_id: id,
          object_event_types: ["item:completed"],
          limit: 100,
        });
        events = res.results ?? [];
      } catch (e) {
        this.log(`couldn't read Todoist's activity log for "${line.text}", so its completions there get no ticked lines: ${(e as Error).message}`);
        delete rec.historyDue;
        continue;
      }
      const history = historyLines(line, id, events, due.from, due.to);
      if (history.length) {
        await this.addHistory(id, history);
        this.log(`"${line.text}": ${history.length} completion(s) in Todoist, kept as ticked lines`);
        delete rec.historyDue;
      } else if (Date.now() > due.until) {
        this.log(`"${line.text}": no completion in Todoist's activity log from ${due.from} to ${due.to}, so no ticked line`);
        delete rec.historyDue;
      } else {
        this.log(`"${line.text}": Todoist's activity log has ${events.length} event(s), none a completion from ${due.from} to ${due.to} yet; looking again at the next pull`);
      }
    }
  }

  /**
   * Put history lines next to the task's line in its home note, newest nearest: below it and its
   * subtasks, or above it, as Tasks places a repeating task's lines.
   */
  private async addHistory(id: string, history: string[]): Promise<void> {
    const rec = this.state.tasks[id];
    if (!rec) return;
    const above = !!this.settings().historyAbove;
    await this.vault.process(rec.path, (content) => {
      const lines = content.split("\n");
      const at = findLineByMarker(lines, id);
      if (at < 0) return content;
      if (above) lines.splice(at, 0, ...[...history].reverse());
      // Below its subtasks, so they stay under it.
      else lines.splice(blockEnd(lines, at) + 1, 0, ...history);
      return lines.join("\n");
    });
  }

  /**
   * A task's fields from its lines (more than one when it has copies), as `localFields` gives one
   * line's: for each field, the first line whose value differs from the last sync, or the first
   * line's. Lines come most recently edited first, so that one's change wins.
   */
  private combinedLocal(tasks: ParsedTask[], rec: TaskRecord): TaskFields {
    const legacy = this.isLegacy(rec);
    const all = tasks.map((t) => this.localFields(t, legacy));
    const out = { ...all[0] };
    const base = (k: keyof TaskFields) =>
      k === "priority" ? (rec.base.priority ?? 4) : k === "deadline" || k === "recurrence" ? (rec.base[k] ?? null) : rec.base[k];
    for (const k of Object.keys(out) as (keyof TaskFields)[]) {
      const changed = all.find((f) => f[k] !== undefined && f[k] !== base(k));
      if (changed) (out as Record<string, unknown>)[k] = changed[k];
    }
    return out;
  }

  /** The notes with a line for a task: its home, then its copies. */
  private locations(rec: TaskRecord | undefined): string[] {
    return rec ? [rec.path, ...(rec.copies ?? []).filter((p) => p !== rec.path)] : [];
  }

  private async readOrEmpty(path: string): Promise<string> {
    try {
      return (await this.vault.read(path)) ?? "";
    } catch {
      return "";
    }
  }

  /**
   * A line for a task found in `path`, a note other than its home: a copy if its home still has
   * the task, otherwise the task moved here, which becomes its home.
   */
  private async placeLine(rec: TaskRecord, id: string, path: string): Promise<void> {
    if ((await this.readOrEmpty(rec.path)).includes(`%%td:${id}%%`)) {
      if (!rec.copies?.includes(path)) rec.copies = [...(rec.copies ?? []), path];
    } else {
      rec.path = path;
      this.dropCopy(rec, path);
    }
  }

  private dropCopy(rec: TaskRecord, path: string): void {
    rec.copies = rec.copies?.filter((p) => p !== path);
    if (!rec.copies?.length) delete rec.copies;
  }

  /** The task's line gone from its home: the first copy still in its note becomes home. False if none is. */
  private async promoteCopy(rec: TaskRecord, id: string): Promise<boolean> {
    while (rec.copies?.length) {
      const next = rec.copies[0];
      this.dropCopy(rec, next);
      if ((await this.readOrEmpty(next)).includes(`%%td:${id}%%`)) {
        rec.path = next;
        return true;
      }
    }
    return false;
  }

  /**
   * Write tasks' synced fields to each of their lines in `paths` that differs, leaving the line
   * being edited (`skip`) alone. A note is only written if a line in it changes.
   */
  private async writeLines(targets: Map<string, LineTarget>, paths: Iterable<string>, skip?: { path: string; line: number }): Promise<void> {
    if (!targets.size) return;
    for (const p of new Set(paths)) {
      const rewrite = (content: string): string | null => {
        const lines = content.split("\n");
        let changed = false;
        for (const { line, task } of findTasks(content)) {
          const target = task.todoistId ? targets.get(task.todoistId) : undefined;
          if (!target || (skip?.path === p && skip.line === line)) continue;
          const next = this.syncedLine(task, target);
          if (next !== null && next !== lines[line]) {
            lines[line] = next;
            changed = true;
          }
        }
        return changed ? lines.join("\n") : null;
      };
      if (rewrite(await this.readOrEmpty(p)) === null) continue;
      await this.vault.process(p, (content) => rewrite(content) ?? content);
    }
  }

  /** A task's line with its synced fields, or null if it already has them. */
  private syncedLine(parsed: ParsedTask, target: LineTarget): string | null {
    const f = target.fields;
    let t = withTitle(parsed, target.title);
    if (t === parsed) t = withTitle(parsed, f.text);
    if (target.legacy && t.deadline && !t.due) t = { ...t, due: t.deadline, deadline: null };
    let fields = t.fields;
    let differs = t.text !== f.text || t.checked !== f.checked || t.due !== f.due;
    if (f.deadline !== undefined && (t.deadline ?? null) !== f.deadline) differs = true;
    if (this.tasksFields()) {
      if (f.priority !== undefined && linePriority(t) !== f.priority) {
        fields = withLinePriority(fields, f.priority);
        differs = true;
      }
      if (f.checked && !t.checked) fields = withDoneDate(fields, isoDate(target.completedAt ? new Date(target.completedAt) : new Date()));
      if (!f.checked && t.checked) fields = withDoneDate(fields, null);
      const rule = t.fields?.recurrence;
      const lineRule = rule ? canonicalRule(rule) : null;
      if (f.recurrence !== undefined && lineRule !== undefined && lineRule !== f.recurrence) {
        fields = { ...fields };
        if (f.recurrence) fields.recurrence = f.recurrence;
        else delete fields.recurrence;
        differs = true;
      }
    }
    if (!differs) return null;
    const next: ParsedTask = { ...t, text: f.text, checked: f.checked, due: f.due, fields };
    if (f.deadline !== undefined) next.deadline = f.deadline;
    return serializeTask(next);
  }

  // ---------------------------------------------------------------- vault events

  onRename(oldPath: string, newPath: string): void {
    for (const rec of Object.values(this.state.tasks)) {
      if (rec.path === oldPath) rec.path = newPath;
      if (rec.copies) rec.copies = rec.copies.map((p) => (p === oldPath ? newPath : p));
    }
    for (const p of Object.values(this.state.pending)) if (p.path === oldPath) p.path = newPath;
    void this.save();
  }

  onDelete(path: string): void {
    for (const [id, rec] of Object.entries(this.state.tasks)) {
      if (rec.copies?.includes(path)) this.dropCopy(rec, path);
      if (rec.path !== path) continue;
      // Its first copy becomes home; if that note turns out not to have it, its next push says so.
      const next = rec.copies?.[0];
      if (next) {
        rec.path = next;
        this.dropCopy(rec, next);
      } else delete this.state.tasks[id];
    }
    void this.save();
  }
}

/** Comparison key for project names: case- and whitespace-insensitive. */
export function projectKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** References applied to a synced task by one push, to remove from its line. */
interface AppliedRefs {
  project?: boolean;
  labels?: string[];
  priority?: number;
  due?: string;
}

/**
 * Todoist due object for a date in words. Todoist parses the string as its Quick Add does
 * (numeric dates follow the user's Todoist date format), including recurrence ("every monday").
 */
export function dueFromWords(words: string): { string: string; lang: string } {
  return { string: words, lang: "en" };
}

/** `pN` as written (1 = p1, urgent) → Todoist's API value (4 = urgent … 1 = none). */
export function toApiPriority(p: number): number {
  return 5 - p;
}

/** Labels match like projects: ignoring case and extra spaces. */
export const labelKey = projectKey;

/** Key prefix for labels created by this device that no pull has confirmed yet. */
const NEW_LABEL = "new:";

function pickFields(src: TaskFields, keys: Partial<TaskFields>): Partial<TaskFields> {
  const out: Partial<TaskFields> = {};
  for (const k of Object.keys(keys) as (keyof TaskFields)[]) (out as Record<string, unknown>)[k] = src[k];
  return out;
}

/**
 * Todoist commands for a change to a task's fields. `due` is the Todoist due object for its date
 * and repeat as synced (see SyncEngine.dueArg), sent if either changed; without it, the date alone.
 */
export function commandsFor(id: string, change: Partial<TaskFields>, due?: Record<string, unknown> | null): Command[] {
  const cmds: Command[] = [];
  const args: Record<string, unknown> = { id };
  if ("text" in change) args.content = change.text;
  if ("due" in change || "recurrence" in change) args.due = due !== undefined ? due : change.due ? { date: change.due } : null;
  if (change.priority !== undefined) args.priority = toApiPriority(change.priority);
  if (change.deadline !== undefined) args.deadline = change.deadline ? { date: change.deadline } : null;
  if (Object.keys(args).length > 1) cmds.push({ type: "item_update", uuid: makeUuid(), args });
  if ("checked" in change) {
    cmds.push({ type: change.checked ? "item_close" : "item_uncomplete", uuid: makeUuid(), args: { id } });
  }
  return cmds;
}
