import { EditorView } from "@codemirror/view";
import { Editor, editorInfoField, MarkdownView, normalizePath, Notice, Platform, Plugin, requestUrl, TAbstractFile, TFile } from "obsidian";
import { DEFAULT_SETTINGS, InlineTasksSettingTab, type InlineTasksSettings } from "./settings";
import { CATALOG_FILE, catalogNote } from "./sync/catalog";
import { labelKey, SyncEngine, type VaultAdapter } from "./sync/engine";
import { blockEnd, findLineByMarker, parseTaskLine, withPickedLabels, withRef } from "./parse/taskLine";
import { importLines, withMissingSubtasks } from "./sync/importTask";
import { OriginTracker } from "./sync/origin";
import { projectRef } from "./sync/projects";
import { emptyState, subtaskCount, type SyncState } from "./sync/state";
import { TodoistClient, TodoistError, type HttpFn, type TodoistItem } from "./todoist/client";
import { BackfillModal } from "./ui/backfillModal";
import { ImportModal } from "./ui/importModal";
import { DueModal } from "./ui/dueModal";
import { PriorityModal } from "./ui/priorityModal";
import { ProjectModal } from "./ui/projectModal";
import { SubtaskChoiceModal } from "./ui/subtaskChoiceModal";
import { chipExtension, refreshChips } from "./ui/chipExtension";
import { localEditTracker } from "./ui/localEdits";
import { LabelModal, type LabelPick } from "./ui/labelModal";
import { labelTrigger } from "./ui/labelTrigger";
import { ProjectSuggest } from "./ui/projectSuggest";
import { readingChipProcessor } from "./ui/readingChip";

/** `data.json`, which Obsidian Sync shares between devices. Sync state is kept per device instead. */
interface PluginData {
  settings: InlineTasksSettings;
  backfillDone?: boolean;
  /** Sync state, as saved by versions before it moved to per-device storage. Migrated on load. */
  state?: SyncState;
}

/** Local-storage key (scoped to this vault by Obsidian) for this device's sync state. */
const STATE_KEY = "inline-tasks-state";
const PUSH_DEBOUNCE_MS = 3000;
const DIRTY_RETRY_MS = 15000;
const LOG_LINES = 400;

export default class InlineTasksPlugin extends Plugin {
  settings: InlineTasksSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = emptyState();
  engine!: SyncEngine;

  private dirty = new Set<string>();
  /** Notes with a label picker open from a typed `@`: not pushed until it closes, so the `@` never reaches a title. */
  private picking = new Set<string>();
  private pushTimer: number | null = null;
  private pullTimer: number | null = null;
  private chipVersion = 0;
  private lastErrorAt = 0;
  private backfillPrompted = false;
  /** Where each note's latest change came from (see sync/origin.ts). */
  private origin = new OriginTracker();
  /** Last key press, click or tap in this window. */
  private lastInputAt = 0;
  private logLines: string[] = [];
  /** backfillDone as last written to data.json, so data.json is only rewritten when it changes. */
  private savedBackfill: boolean | undefined;
  /** This device had no sync state of its own or to migrate: link the markers already in the vault. */
  private freshState = false;
  private storageWarned = false;

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    const local = this.loadDeviceState();
    this.freshState = !local && !data.state;
    this.state = { ...emptyState(), ...(local ?? data.state) };
    this.state.backfillDone = !!(data.backfillDone || data.state?.backfillDone || this.state.backfillDone);
    this.savedBackfill = data.backfillDone;
    if (!local) this.saveDeviceState();
    // Drop the shared copy, so no device loads another's state from it again. (Never write data.json
    // otherwise on load: on a new device, Sync may not have delivered it yet.)
    if (data.state) await this.saveAll();
    const migrated = !local && !!data.state;

    const http: HttpFn = async (req) => {
      const res = await requestUrl({ ...req, throw: false });
      let json: unknown = null;
      try {
        json = res.json;
      } catch {
        /* non-JSON error body */
      }
      return { status: res.status, json };
    };

    this.engine = new SyncEngine(
      new TodoistClient(() => this.settings.apiToken, http),
      this.vaultAdapter(),
      this.state,
      () => ({ ...this.settings, canCreate: this.canCreate, indent: this.indentUnit() }),
      () => this.saveState(),
      (msg) => this.log(msg),
    );

    this.addSettingTab(new InlineTasksSettingTab(this.app, this));
    const chipActions = { subtasks: (id: string) => void this.insertMissingSubtasks(id), project: (id: string) => this.changeProject(id), labels: (id: string) => this.changeLabels(id), priority: (id: string) => this.changePriority(id), due: (id: string) => this.changeDue(id) };
    this.registerEditorExtension(chipExtension(() => this.state, () => this.chipVersion, chipActions));
    this.registerEditorExtension(
      localEditTracker(
        (path) => this.origin.localEdit(path, Date.now()),
        () => this.lastInputAt,
      ),
    );
    // Real user input anywhere in this window. Captured before Obsidian or the editor handle it.
    for (const type of ["keydown", "pointerdown", "touchstart", "paste", "drop"] as const) {
      this.registerDomEvent(document, type, () => (this.lastInputAt = Date.now()), { capture: true });
    }
    this.registerMarkdownPostProcessor(readingChipProcessor(() => this.state, chipActions));
    this.registerSuggests();

    this.registerEvent(this.app.vault.on("modify", (f) => void this.onWrite(f)));
    this.registerEvent(
      this.app.vault.on("rename", (f, old) => {
        this.origin.rename(old, f.path);
        this.engine.onRename(old, f.path);
      }),
    );
    this.registerEvent(this.app.vault.on("delete", (f) => this.engine.onDelete(f.path)));
    this.registerDomEvent(window, "focus", () => void this.runPull());
    this.registerInterval(window.setInterval(() => this.dirty.size && void this.flush(), DIRTY_RETRY_MS));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: async () => {
        const path = await this.saveActiveEditor();
        if (path) this.dirty.add(path);
        await this.flush(true);
        await this.runPull(true);
      },
    });
    this.addCommand({
      id: "sync-current-note",
      name: "Sync current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) {
          void this.guard(async () => {
            await this.saveActiveEditor();
            await this.engine.pushFile(file.path);
            this.refresh();
          }, true);
        }
        return true;
      },
    });
    this.addCommand({
      id: "import-task",
      name: "Import task from Todoist",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file || !this.settings.apiToken || !this.state.backfillDone || !this.engine.isFileEligible(file.path)) return false;
        if (!checking) void this.importTask(editor, file.path);
        return true;
      },
    });
    this.addCommand({
      id: "insert-subtasks",
      name: "Add missing subtasks from Todoist",
      editorCheckCallback: (checking, editor) => {
        const id = parseTaskLine(editor.getLine(editor.getCursor().line))?.todoistId;
        if (!id || !this.settings.apiToken || !this.engine.isLinked(id)) return false;
        if (!checking) void this.insertMissingSubtasks(id);
        return true;
      },
    });
    this.addCommand({ id: "backfill", name: "Review backfill of existing checkboxes", callback: () => this.openBackfill() });
    this.addCommand({ id: "save-log", name: "Save sync log to a note", callback: () => this.saveLog() });

    this.app.workspace.onLayoutReady(async () => {
      // Registered here because Obsidian fires `create` for every file while the vault loads.
      this.registerEvent(this.app.vault.on("create", (f) => void this.onWrite(f)));
      this.schedulePull();
      this.log(`loaded on ${this.deviceName}; creates tasks: ${this.canCreate}, from elsewhere: ${this.createFromElsewhere}`);
      if (migrated) this.log("moved sync state from data.json to this device");
      if (this.freshState && this.state.backfillDone) {
        const n = await this.engine.linkExisting();
        this.log(`no sync state on this device; linked ${n} existing task(s)`);
      }
      if (!this.state.relaidOut || !this.state.datesMigrated) {
        // Lines from earlier versions: the marker after the fields, or the Todoist date as `📅`.
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const skip = view?.file && view.getMode() === "source" ? { path: view.file.path, line: view.editor.getCursor().line } : undefined;
        const n = await this.guard(() => this.engine.migrateVault(skip));
        if (n) this.log(`rewrote ${n} line(s) from an earlier version`);
      }
      if (this.settings.apiToken) {
        await this.runPull();
        this.maybePromptBackfill();
      }
    });
  }

  onunload(): void {
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    if (this.pullTimer) window.clearInterval(this.pullTimer);
  }

  /** Save settings (shared through data.json). */
  async saveAll(): Promise<void> {
    await this.saveData({ settings: this.settings, backfillDone: this.state.backfillDone } satisfies PluginData);
    this.savedBackfill = this.state.backfillDone;
  }

  /** Save this device's sync state; also data.json if the shared backfill flag changed. */
  private async saveState(): Promise<void> {
    this.saveDeviceState();
    if (this.state.backfillDone !== this.savedBackfill) await this.saveAll();
  }

  /** Settings changed on another device (Obsidian Sync rewrote data.json). */
  async onExternalSettingsChange(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.savedBackfill = data.backfillDone;
    if (data.backfillDone && !this.state.backfillDone) {
      this.state.backfillDone = true;
      this.saveDeviceState();
    }
    this.schedulePull();
  }

  private loadDeviceState(): SyncState | null {
    const raw: unknown = this.app.loadLocalStorage(STATE_KEY);
    return raw && typeof raw === "object" ? (raw as SyncState) : null;
  }

  private saveDeviceState(): void {
    try {
      this.app.saveLocalStorage(STATE_KEY, this.state);
    } catch (e) {
      this.log(`error: couldn't save sync state: ${(e as Error).message}`);
      if (!this.storageWarned) {
        this.storageWarned = true;
        new Notice(`Todoist sync: couldn't save sync state on this device (${(e as Error).message})`);
      }
    }
  }

  // ------------------------------------------------------------ per-device settings
  // Kept in localStorage, not data.json, because Obsidian Sync shares data.json between devices.

  /** Whether this device creates Todoist tasks at all. */
  get canCreate(): boolean {
    return window.localStorage.getItem(this.deviceKey("canCreate")) !== "false";
  }
  set canCreate(v: boolean) {
    window.localStorage.setItem(this.deviceKey("canCreate"), String(v));
  }

  /**
   * Whether this device creates tasks for checkboxes that arrived from another device or app (after
   * the quiet period). On by default on desktop and off on mobile, so a note written by a script or
   * agent is created once, by the desktop, not once per device.
   */
  get createFromElsewhere(): boolean {
    const v = window.localStorage.getItem(this.deviceKey("createFromElsewhere"));
    return v === null ? !Platform.isMobile : v === "true";
  }
  set createFromElsewhere(v: boolean) {
    window.localStorage.setItem(this.deviceKey("createFromElsewhere"), String(v));
  }

  private deviceKey(name: string): string {
    return `inline-tasks:${this.app.vault.getName()}:${name}`;
  }

  private get deviceName(): string {
    return Platform.isMobile ? (Platform.isAndroidApp ? "android" : Platform.isIosApp ? "ios" : "mobile") : "desktop";
  }

  /** The `#[` project picker and the `@` label picker. */
  private registerSuggests(): void {
    const enabled = (file: TFile | null) =>
      !!file && !!this.settings.apiToken && this.state.backfillDone && this.engine.isFileEligible(file.path);
    const projects = new ProjectSuggest(this.app, () => this.state, enabled);
    this.registerEditorSuggest(projects);
    // Obsidian shows only the first suggester that offers anything, in the order they were
    // registered. The Tasks plugin's offers its fields anywhere on a task line, so if it loaded
    // first it would hide this one. This one only offers anything after `#[`, so it goes first.
    // `editorSuggest.suggests` isn't in Obsidian's public API; without it, the order stays as is.
    const suggests = (this.app.workspace as unknown as { editorSuggest?: { suggests?: unknown[] } }).editorSuggest?.suggests;
    const at = suggests?.indexOf(projects) ?? -1;
    if (suggests && at > 0) {
      suggests.splice(at, 1);
      suggests.unshift(projects);
    }
    this.registerEditorExtension(labelTrigger(enabled, (view, pos) => this.labelsFromAt(view, pos)));
  }

  // ------------------------------------------------------------ label picker

  /** Pick a synced task's labels, from a click on one of its chip's labels. */
  private changeLabels(id: string): void {
    if (!this.engine.isLinked(id) || !this.settings.apiToken) return;
    new LabelModal(this.app, this.state, this.state.remote[id]?.labels ?? [], (pick) => {
      if (pick.add.length || pick.remove.length) void this.applyLabels(id, pick);
    }).open();
  }

  private async applyLabels(id: string, pick: LabelPick): Promise<void> {
    await this.guard(() => this.engine.changeLabels(id, pick.add, pick.remove), true);
    this.refresh();
  }

  /**
   * `@` was typed on a checkbox line at `pos`: open the label picker. A synced task's labels are
   * changed in Todoist when it closes, and the `@` is removed. On a line not synced yet, the `@` is
   * replaced by references to the labels picked, which sync applies when it creates the task. Closed
   * with nothing ticked or unticked, it cancels: the `@` is removed, and what was typed in the search
   * box is dropped, so a label is only ever created by choosing **Create label**.
   */
  private labelsFromAt(view: EditorView, pos: number): void {
    const task = parseTaskLine(view.state.doc.lineAt(pos).text);
    if (!task) return;
    const id = task.todoistId && this.engine.isLinked(task.todoistId) ? task.todoistId : null;
    const current = id ? (this.state.remote[id]?.labels ?? []) : task.labelRefs.map((r) => this.engine.findLabel(r) ?? r);
    const path = view.state.field(editorInfoField, false)?.file?.path;
    if (path) this.picking.add(path);
    new LabelModal(this.app, this.state, current, (pick) => {
      if (path) this.picking.delete(path);
      const changed = pick.add.length > 0 || pick.remove.length > 0;
      const doc = view.state.doc;
      if (pos < doc.length && doc.sliceString(pos, pos + 1) === "@") {
        const line = doc.lineAt(pos);
        const at = pos - line.from;
        const drop = new Set(pick.remove.map(labelKey));
        // The `@` goes in any case: replaced by references on a line not synced yet, otherwise just removed.
        const next =
          !changed || id
            ? withPickedLabels(line.text, at, [], () => false)
            : withPickedLabels(line.text, at, pick.add, (n) => drop.has(labelKey(n)));
        view.dispatch({
          changes: next.line === line.text ? undefined : { from: line.from, to: line.to, insert: next.line },
          selection: { anchor: line.from + next.cursor },
          userEvent: "input",
        });
      }
      view.focus();
      if (id && changed) void this.applyLabels(id, pick);
    }).open();
  }

  // ------------------------------------------------------------ import

  /**
   * Pick an open Todoist task and insert it at the cursor, with its open subtasks if the
   * **Import subtasks** setting says so (or, set to ask, if the user chooses them).
   */
  private async importTask(editor: Editor, path: string): Promise<void> {
    const items = await this.guard(() => this.engine.openTasks(), true);
    if (!items) return;
    const isLinked = (id: string) => this.engine.isLinked(id);
    new ImportModal(this.app, this.state, items, isLinked, (root) => {
      const subtasks = importLines(root, items, isLinked, "", "").items.length - 1;
      const mode = this.settings.importSubtasks;
      const insert = (withSubtasks: boolean) => void this.guard(() => this.insertImport(editor, path, root, items, withSubtasks), true);
      if (!subtasks || mode !== "ask") insert(mode !== "never");
      else new SubtaskChoiceModal(this.app, root.content, subtasks, insert).open();
    }).open();
  }

  /** Insert an imported task (and its subtasks) at the cursor: see the README's Importing a task. */
  private async insertImport(editor: Editor, path: string, root: TodoistItem, open: TodoistItem[], withSubtasks: boolean): Promise<void> {
    const cursor = editor.getCursor();
    const current = editor.getLine(cursor.line);
    const list = /^(\s*)(?:[-*+]|\d+[.)])(?:\s+\[.\])?\s*(.*)$/.exec(current);
    // An empty line (or empty list item) is replaced; otherwise the task goes on the next line.
    const replace = current.trim() === "" || (!!list && list[2] === "");
    const indent = list ? list[1] : replace ? (/^\s*/.exec(current)?.[0] ?? "") : "";
    const { lines, items } = importLines(root, open, (id) => this.engine.isLinked(id), indent, this.indentUnit(), withSubtasks, this.settings.tasksFields);
    // Linked before the lines are written, so a sync that runs first sees them as synced, not new.
    await this.engine.registerImport(path, items.map((item, i) => ({ item, line: lines[i] })));
    const text = lines.join("\n");
    if (replace) {
      editor.replaceRange(text, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: current.length });
    } else {
      editor.replaceRange(`\n${text}`, { line: cursor.line, ch: current.length });
    }
    const last = cursor.line + (replace ? 0 : 1) + lines.length - 1;
    editor.setCursor({ line: last, ch: editor.getLine(last).length });
    this.refresh();
  }

  /** One level of list indentation, as the editor is set to write it. */
  private indentUnit(): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (this.app.vault as any).getConfig?.bind(this.app.vault) as ((k: string) => unknown) | undefined;
    return config?.("useTab") === false ? " ".repeat(Number(config("tabSize")) || 4) : "\t";
  }

  /**
   * Insert a synced task's open subtasks that aren't in any note yet beneath its line, after any
   * subtasks already there. From the command, or a click on the chip's subtask count.
   */
  private async insertMissingSubtasks(id: string): Promise<void> {
    const rec = this.state.tasks[id];
    const file = rec && this.app.vault.getAbstractFileByPath(rec.path);
    if (!rec || rec.orphaned || !(file instanceof TFile)) return;
    const open = await this.guard(() => this.engine.openTasks(), true);
    if (!open) return;
    this.refresh(); // the read also refreshed the counts
    const isLinked = (t: string) => this.engine.isLinked(t);
    const editor = this.editorFor(file.path);
    const read = async () => (editor ? editor.getValue() : await this.app.vault.read(file)).split("\n");

    const tab = this.indentUnit();
    const lines = await read();
    const idx = findLineByMarker(lines, id);
    if (idx < 0) return;
    const { added } = withMissingSubtasks(lines, idx, id, open, isLinked, tab, this.settings.tasksFields);
    if (!added.length) {
      new Notice(subtaskCount(this.state, id) ? "Its open subtasks are already in your notes" : "This task has no open subtasks");
      return;
    }
    // Linked before the lines are written, so a sync that runs first sees them as synced, not new.
    await this.engine.registerImport(file.path, added);
    // Placed again, in case the note changed meanwhile; the ones just linked still count as missing.
    const adding = new Set(added.map((a) => a.item.id));
    const place = (ls: string[], at: number) => withMissingSubtasks(ls, at, id, open, (t) => !adding.has(t) && isLinked(t), tab, this.settings.tasksFields).lines;
    if (editor) {
      const ls = await read();
      const at = findLineByMarker(ls, id);
      if (at >= 0) {
        // Replace the block nested under the task with the block including the new subtasks.
        const end = blockEnd(ls, at);
        const next = place(ls, at);
        const block = next.slice(at + 1, end + 1 + next.length - ls.length);
        editor.replaceRange(`\n${block.join("\n")}`, { line: at, ch: ls[at].length }, { line: end, ch: ls[end].length });
      }
    } else {
      await this.app.vault.process(file, (c) => {
        const ls = c.split("\n");
        const at = findLineByMarker(ls, id);
        return at < 0 ? c : place(ls, at).join("\n");
      });
    }
    new Notice(added.length === 1 ? "Added 1 subtask" : `Added ${added.length} subtasks`);
    this.refresh();
  }

  // ------------------------------------------------------------ project picker

  /** Pick a project to move a synced task to, from a click on its chip's project. */
  private changeProject(id: string): void {
    const rec = this.state.tasks[id];
    if (!rec || rec.orphaned || !this.settings.apiToken) return;
    new ProjectModal(this.app, this.state, this.state.remote[id]?.projectId, (name, chosen) => {
      // The move goes through a `#[Name]` reference: a project sharing its name with another is
      // named by its path, `Work/Clients`. One whose name has a `]` or `/` may not be nameable.
      const ref = chosen ? projectRef(this.state, chosen) : name;
      if (!ref) {
        new Notice(`Can't move a task to “${name}” from here, because no reference names only it. Use Todoist instead.`);
        return;
      }
      void this.guard(() => this.addRefAndPush(id, `#[${ref}]`, `moving ${id} to project "${ref}"`), true);
    }).open();
  }

  // ------------------------------------------------------------ due date picker

  /** Pick a synced task's due date, from a click on its chip's date. */
  private changeDue(id: string): void {
    if (!this.engine.isLinked(id) || !this.settings.apiToken) return;
    const meta = this.state.remote[id];
    new DueModal(this.app, meta?.due ?? null, !!meta?.recurring, (pick) => {
      void (async () => {
        // Save open editors first, so the pull that writes the new date doesn't race unsaved text.
        await this.saveViewsOf(this.state.tasks[id]?.path ?? "");
        await this.guard(() => this.engine.changeDue(id, pick), true);
        this.refresh();
      })();
    }).open();
  }

  /** Save every open editor of `path`. */
  private async saveViewsOf(path: string): Promise<void> {
    const views: MarkdownView[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) views.push(leaf.view);
    });
    for (const v of views) await v.save();
  }

  // ------------------------------------------------------------ priority picker

  /** Pick a synced task's priority, from a click on its chip's priority. */
  private changePriority(id: string): void {
    if (!this.engine.isLinked(id) || !this.settings.apiToken) return;
    const current = 5 - (this.state.remote[id]?.priority ?? 1); // Todoist's 4 is p1, and 1 is p4
    new PriorityModal(this.app, current, (p) => {
      void this.guard(() => this.addRefAndPush(id, `p${p}`, `setting ${id} to p${p}`), true);
    }).open();
  }

  /**
   * Add a reference (`#[Project]`, `p2`) to a task's line and push the note straight away, so a
   * change picked on the chip goes the same way as a typed reference: a nested line filed in another
   * project moves out of its block, a missing project is created, and if Todoist can't be reached
   * the reference stays on the line until it can.
   */
  private async addRefAndPush(id: string, ref: string, what: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.state.tasks[id]?.path ?? "");
    if (!(file instanceof TFile)) return;
    await this.saveViewsOf(file.path); // so the write below doesn't race their unsaved text
    this.origin.localEdit(file.path, Date.now()); // the user's own change, so pushed straight away
    let added = false;
    await this.app.vault.process(file, (content) => {
      const lines = content.split("\n");
      const at = findLineByMarker(lines, id);
      if (at < 0) return content;
      lines[at] = withRef(lines[at], ref);
      added = true;
      return lines.join("\n");
    });
    if (!added) return;
    this.log(`${file.path}: ${what} (chip)`);
    await this.engine.pushFile(file.path);
    this.refresh();
  }

  /** The editor showing `path` in live preview or source mode, if any (the active one first). */
  private editorFor(path: string): Editor | undefined {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === path && active.getMode() === "source") return active.editor;
    let found: Editor | undefined;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (!found && v instanceof MarkdownView && v.file?.path === path && v.getMode() === "source") found = v.editor;
    });
    return found;
  }

  // ------------------------------------------------------------ log

  log(msg: string): void {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    console.log(`[inline-tasks] ${msg}`);
    this.logLines.push(line);
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
  }

  private async saveLog(): Promise<void> {
    const path = `Inline Tasks sync log (${this.deviceName}).md`;
    const body = [
      `Sync log from ${this.deviceName}, saved ${new Date().toISOString()} (times are UTC).`,
      "",
      "```",
      ...this.logLines,
      "```",
      "",
    ].join("\n");
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, body);
    else await this.app.vault.create(path, body);
    new Notice(`Saved ${path}`);
  }

  // ------------------------------------------------------------ scheduling

  schedulePull(): void {
    if (this.pullTimer) window.clearInterval(this.pullTimer);
    this.pullTimer = window.setInterval(() => void this.runPull(), this.settings.pullIntervalMinutes * 60_000);
    this.registerInterval(this.pullTimer);
  }

  /** A note was written: note where the change came from, then schedule a push. */
  private async onWrite(f: TAbstractFile): Promise<void> {
    if (!(f instanceof TFile) || f.extension !== "md" || f.path.startsWith("Inline Tasks sync log") || f.path === this.catalogPath()) return;
    const origin = this.origin.modified(f.path, await this.app.vault.read(f), Date.now());
    if (origin !== "own") this.log(`${f.path}: changed (${origin})`);
    this.dirty.add(f.path);
    if (this.pushTimer) window.clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => void this.flush(), PUSH_DEBOUNCE_MS);
  }

  private async flush(force = false): Promise<void> {
    if (!this.settings.apiToken) return;
    const paths = [...this.dirty];
    this.dirty.clear();
    for (const path of paths) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) continue;
      if (this.picking.has(path)) {
        this.dirty.add(path); // pushed once the label picker closes
        continue;
      }
      const status = this.origin.status(path, Date.now());
      // Changed on another device (or by another app): let that device push it first.
      if (!force && status.hold) {
        this.dirty.add(path);
        continue;
      }
      const noCreate = !force && status.fromElsewhere && !this.createFromElsewhere;
      const editor = force ? undefined : () => this.openEditor(path);
      const res = await this.guard(() => this.engine.pushFile(path, { editor, noCreate }));
      if (res?.deferred) this.log(`${path}: deferred (being edited)`);
      if (!res || res.deferred) this.dirty.add(path);
    }
    // A task linked on another device arrived here: fetch its project and due date for the chip now,
    // rather than at the next scheduled pull.
    // Or a due date in words was sent: fetch the date Todoist worked out, to write it to the line.
    if (this.engine.takePullRequest() || this.engine.missingDetails().length) await this.runPull();
    else this.refresh();
  }

  async runPull(notify = false): Promise<void> {
    if (!this.settings.apiToken) return;
    await this.guard(() => this.engine.pull(), notify);
    this.refresh();
    await this.writeCatalog();
    if (notify) new Notice("Todoist: synced");
  }

  // ------------------------------------------------------------ projects and labels note

  defaultCatalogPath(): string {
    return normalizePath(`${this.app.vault.configDir}/${CATALOG_FILE}`);
  }

  /** Where the projects and labels note goes, from the setting. */
  private catalogPath(): string {
    const p = normalizePath(this.settings.catalogNotePath || this.defaultCatalogPath());
    return p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
  }

  /**
   * Write the projects and labels note, if the setting is on and its text has changed. A note under
   * a dot folder (such as the config folder) isn't in Obsidian's vault index, so it's written
   * through the adapter; elsewhere through the vault, so Obsidian sees it.
   */
  async writeCatalog(notify = false): Promise<void> {
    if (!this.settings.catalogNote) return;
    if (!Object.keys(this.state.projects).length) {
      if (notify) new Notice("The projects and labels note is written once the plugin has synced with Todoist");
      return;
    }
    const path = this.catalogPath();
    if (path.split("/").includes("..")) {
      this.log(`error: the projects and labels note location leaves the vault: ${path}`);
      if (notify) new Notice(`The projects and labels note must be inside the vault, not ${path}`);
      return;
    }
    const body = catalogNote(this.state, this.settings);
    const { vault } = this.app;
    const { adapter } = vault;
    try {
      if ((await adapter.exists(path)) && (await adapter.read(path)) === body) {
        if (notify) new Notice(`The projects and labels note is up to date: ${path}`);
        return;
      }
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const file = vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await vault.modify(file, body);
      } else if (path.split("/").some((part) => part.startsWith("."))) {
        if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
        await adapter.write(path, body);
      } else {
        if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
        await vault.create(path, body);
      }
      this.log(`wrote the projects and labels note: ${path}`);
      if (notify) new Notice(`Wrote the projects and labels note: ${path}`);
    } catch (e) {
      this.log(`error: couldn't write the projects and labels note ${path}: ${(e as Error).message}`);
      if (notify) new Notice(`Couldn't write ${path}: ${(e as Error).message}`);
    }
  }

  /** Write the active editor's unsaved text to disk, so an explicit sync pushes what's on screen. */
  private async saveActiveEditor(): Promise<string | undefined> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return undefined;
    await view.save();
    return view.file.path;
  }

  /** Text and cursor line of the active editor, if it's editing `path`. */
  private openEditor(path: string): { content: string; cursorLine: number } | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path !== path || view.getMode() !== "source") return undefined;
    return { content: view.editor.getValue(), cursorLine: view.editor.getCursor().line };
  }

  private async guard<T>(fn: () => Promise<T>, notify = false): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      console.error("[inline-tasks]", e);
      this.log(`error: ${(e as Error).message}`);
      // Network blips are retried silently; surface auth errors and explicit requests (at most once a minute).
      const auth = e instanceof TodoistError && (e.status === 401 || e.status === 403 || !e.status);
      if (notify || (auth && Date.now() - this.lastErrorAt > 60_000)) {
        this.lastErrorAt = Date.now();
        new Notice(`Todoist sync: ${(e as Error).message}`);
      }
      return undefined;
    }
  }

  /** Re-render chips in open editors and reading views. */
  private refresh(): void {
    this.chipVersion++;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cm = (leaf.view.editor as any).cm as EditorView | undefined;
      cm?.dispatch({ effects: refreshChips.of(null) });
      if (leaf.view.getMode() === "preview") leaf.view.previewMode.rerender(true);
    });
  }

  // ------------------------------------------------------------ backfill

  maybePromptBackfill(): void {
    if (this.state.backfillDone || this.backfillPrompted || !this.settings.apiToken) return;
    this.backfillPrompted = true;
    this.openBackfill();
  }

  async openBackfill(): Promise<void> {
    if (!this.settings.apiToken) {
      new Notice("Add your Todoist API token in settings first");
      return;
    }
    const counts = await this.engine.countBackfill();
    new BackfillModal(this.app, counts, async () => {
      await this.guard(() => this.engine.runBackfill(), true);
      this.refresh();
    }).open();
  }

  // ------------------------------------------------------------ adapter

  private vaultAdapter(): VaultAdapter {
    const { vault, metadataCache } = this.app;
    const file = (p: string) => {
      const f = vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) throw new Error(`Not a file: ${p}`);
      return f;
    };
    return {
      read: (p) => vault.read(file(p)),
      process: async (p, fn) => {
        // Remember what we write, so the resulting modify event is recognised as our own.
        await vault.process(file(p), (content) => {
          const out = fn(content);
          if (out !== content) this.origin.ownWrite(p, out);
          return out;
        });
      },
      mtime: (p) => file(p).stat.mtime,
      frontmatter: (p) => {
        const f = vault.getAbstractFileByPath(p);
        return f instanceof TFile ? metadataCache.getFileCache(f)?.frontmatter : undefined;
      },
      markdownFiles: () => vault.getMarkdownFiles().map((f) => f.path),
      vaultName: () => vault.getName(),
    };
  }
}
