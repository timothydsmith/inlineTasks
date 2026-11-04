import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, Platform, Plugin, requestUrl, TAbstractFile, TFile } from "obsidian";
import { DEFAULT_SETTINGS, InlineTasksSettingTab, type InlineTasksSettings } from "./settings";
import { SyncEngine, type VaultAdapter } from "./sync/engine";
import { OriginTracker } from "./sync/origin";
import { emptyState, type SyncState } from "./sync/state";
import { TodoistClient, TodoistError, type HttpFn } from "./todoist/client";
import { BackfillModal } from "./ui/backfillModal";
import { chipExtension, refreshChips } from "./ui/chipExtension";
import { localEditTracker } from "./ui/localEdits";
import { ProjectSuggest } from "./ui/projectSuggest";
import { readingChipProcessor } from "./ui/readingChip";

interface PluginData {
  settings: InlineTasksSettings;
  state: SyncState;
}

const PUSH_DEBOUNCE_MS = 3000;
const DIRTY_RETRY_MS = 15000;
const LOG_LINES = 400;

export default class InlineTasksPlugin extends Plugin {
  settings: InlineTasksSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = emptyState();
  engine!: SyncEngine;

  private dirty = new Set<string>();
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

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.state = { ...emptyState(), ...data.state };

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
      () => ({ ...this.settings, canCreate: this.canCreate }),
      () => this.saveAll(),
      (msg) => this.log(msg),
    );

    this.addSettingTab(new InlineTasksSettingTab(this.app, this));
    this.registerEditorExtension(chipExtension(() => this.state, () => this.chipVersion));
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
    this.registerMarkdownPostProcessor(readingChipProcessor(() => this.state));
    this.registerProjectSuggest();

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
    this.addCommand({ id: "backfill", name: "Review backfill of existing checkboxes", callback: () => this.openBackfill() });
    this.addCommand({ id: "save-log", name: "Save sync log to a note", callback: () => this.saveLog() });

    this.app.workspace.onLayoutReady(async () => {
      // Registered here because Obsidian fires `create` for every file while the vault loads.
      this.registerEvent(this.app.vault.on("create", (f) => void this.onWrite(f)));
      this.schedulePull();
      this.log(`loaded on ${this.deviceName}; creates tasks: ${this.canCreate}, from elsewhere: ${this.createFromElsewhere}`);
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

  async saveAll(): Promise<void> {
    await this.saveData({ settings: this.settings, state: this.state } satisfies PluginData);
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

  private registerProjectSuggest(): void {
    const suggest = new ProjectSuggest(
      this.app,
      () => this.state,
      (file) => !!file && !!this.settings.apiToken && this.state.backfillDone && this.engine.isFileEligible(file.path),
    );
    this.registerEditorSuggest(suggest);
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
    if (!(f instanceof TFile) || f.extension !== "md" || f.path.startsWith("Inline Tasks sync log")) return;
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
    this.refresh();
  }

  private async runPull(notify = false): Promise<void> {
    if (!this.settings.apiToken) return;
    await this.guard(() => this.engine.pull(), notify);
    this.refresh();
    if (notify) new Notice("Todoist: synced");
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
