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
  /** A push sent something only a pull can complete (a due date in words). See takePullRequest. */
  private wantPull = false;

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

  /** The existing label with this name (its own spelling), ignoring case and surrounding spaces. */
  findLabel(name: string): string | undefined {
    const key = labelKey(name);
    return Object.values(this.state.labels).find((l) => labelKey(l.name) === key)?.name;
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
          if (!task.todoistId || this.state.tasks[task.todoistId]) continue;
          this.state.tasks[task.todoistId] = { path, base: { text: task.text, checked: task.checked, due: task.due } };
          n++;
        }
      }
      if (n) await this.save();
      return n;
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
    /** References this push applied to synced tasks, by task id, to remove from their lines. */
    const applied = new Map<string, AppliedRefs>();
    const markApplied = (id: string, refs: AppliedRefs) => applied.set(id, { ...applied.get(id), ...refs });
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
        if (task.labelRefs.length) {
          const labels = labelNames(task.labelRefs);
          if (!labels) continue; // a label can't be created on this device
          args.labels = labels;
        }
        if (task.priorityRef) args.priority = toApiPriority(task.priorityRef);
        // Due date in words: Todoist works it out, and the next pull writes it to the line.
        if (task.dueRef) args.due = dueFromWords(task.dueRef);
        else if (task.due) args.due = { date: task.due };
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
            markApplied(id, { project: true }); // already there
          } else if (target) {
            const cmd: Command = { type: "item_move", uuid: makeUuid(), args: { id, project_id: target } };
            commands.push(cmd);
            onOk[cmd.uuid] = () => markApplied(id, { project: true });
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
      // writes the date Todoist worked out to the line as `📅`. Not while the line is being edited.
      if (task.dueRef) {
        if (line === opts.skipLine) {
          deferred = true;
        } else {
          const ref = task.dueRef;
          const cmd: Command = { type: "item_update", uuid: makeUuid(), args: { id, due: dueFromWords(ref) } };
          commands.push(cmd);
          const lineDue = local.due;
          onOk[cmd.uuid] = () => {
            markApplied(id, { due: ref });
            // The line's `📅` is superseded: count it as synced, so the pull's date replaces it.
            rec!.base = { ...rec!.base, due: lineDue };
            this.wantPull = true;
          };
        }
      }
      if (adopted) continue;

      const { push } = merge(rec.base, local, rec.base, 0, 0);
      // Words beat an edited `📅` on the same line; they're the newer intent.
      if (task.dueRef && line !== opts.skipLine) delete push.due;
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
      await this.stripRefs(path, applied);
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
      this.state.projects[realId] = { name: cmd.args.name as string };
      delete this.state.pendingProjects[key];
    }
    for (const cmd of commands) {
      if (cmd.type !== "item_move" || !applied.get(cmd.args.id as string)?.project) continue;
      const meta = this.state.remote[cmd.args.id as string];
      const pid = cmd.args.project_id as string;
      if (meta) meta.projectId = mapping[pid] ?? pid;
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
      const pid = cmd?.args.project_id as string | undefined;
      const projectId = pid ? (mapping[pid] ?? pid) : inbox;
      if (!cmd || !projectId || !this.state.tasks[realId] || this.state.remote[realId]) continue;
      const due = cmd.args.due as { date: string } | undefined;
      const labels = (cmd.args.labels as string[] | undefined) ?? [];
      const priority = (cmd.args.priority as number | undefined) ?? 1;
      this.state.remote[realId] = { projectId, priority, due: due?.date ?? null, checked: false, labels };
    }
    await this.stripRefs(path, applied);

    await this.save();
    return { deferred };
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
        const task = idx >= 0 ? parseTaskLine(lines[idx]) : null;
        if (!task) continue;
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
        // The create carried the line's references, so they've done their job.
        lines[idx] = serializeTask({
          ...task,
          pendingUuid: null,
          todoistId: realId,
          projectRef: null,
          labelRefs: [],
          priorityRef: null,
          dueRef: null,
        });
        this.state.tasks[realId] = { path, base: { text: task.text, checked: task.checked, due: task.due } };
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
    const stale =
      Object.values(this.state.projects).some((p) => p.parentId === undefined) || !this.state.labelsSynced;
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
    }
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
