import { EditorView } from "@codemirror/view";
import { MarkdownView, Notice, Plugin, requestUrl, TAbstractFile, TFile } from "obsidian";
import { DEFAULT_SETTINGS, InlineTasksSettingTab, type InlineTasksSettings } from "./settings";
import { SyncEngine, type VaultAdapter } from "./sync/engine";
import { emptyState, type SyncState } from "./sync/state";
import { TodoistClient, TodoistError, type HttpFn } from "./todoist/client";
import { BackfillModal } from "./ui/backfillModal";
import { chipExtension, refreshChips } from "./ui/chipExtension";
import { ProjectSuggest } from "./ui/projectSuggest";
import { readingChipProcessor } from "./ui/readingChip";

interface PluginData {
  settings: InlineTasksSettings;
  state: SyncState;
}

const PUSH_DEBOUNCE_MS = 3000;
const DIRTY_RETRY_MS = 15000;

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
      (msg) => console.log(`[inline-tasks] ${msg}`),
    );

    this.addSettingTab(new InlineTasksSettingTab(this.app, this));
    this.registerEditorExtension(chipExtension(() => this.state, () => this.chipVersion));
    this.registerMarkdownPostProcessor(readingChipProcessor(() => this.state));
    this.registerProjectSuggest();

    this.registerEvent(this.app.vault.on("modify", (f) => this.markDirty(f)));
    this.registerEvent(this.app.vault.on("rename", (f, old) => this.engine.onRename(old, f.path)));
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

    this.app.workspace.onLayoutReady(async () => {
      // Registered here because Obsidian fires `create` for every file while the vault loads.
      this.registerEvent(this.app.vault.on("create", (f) => this.markDirty(f)));
      this.schedulePull();
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

  /** Per-device setting, deliberately kept out of data.json (which Obsidian Sync shares). */
  get canCreate(): boolean {
    return window.localStorage.getItem(this.deviceKey) !== "false";
  }
  set canCreate(v: boolean) {
    window.localStorage.setItem(this.deviceKey, String(v));
  }
  private get deviceKey(): string {
    return `inline-tasks:${this.app.vault.getName()}:canCreate`;
  }

  private registerProjectSuggest(): void {
    const suggest = new ProjectSuggest(
      this.app,
      () => this.state,
      (file) => !!file && !!this.settings.apiToken && this.state.backfillDone && this.engine.isFileEligible(file.path),
    );
    this.registerEditorSuggest(suggest);
    // Obsidian asks suggesters in order and its own tag suggester would claim `#` first.
    // Ours steps aside (returns null) for anything that isn't a project, so put it at the front.
    // `editorSuggest.suggests` is internal; if it ever moves, the picker still works wherever the tag suggester doesn't claim `#`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (this.app.workspace as any).editorSuggest?.suggests as unknown[] | undefined;
    const i = list?.indexOf(suggest) ?? -1;
    if (list && i > 0) list.unshift(...list.splice(i, 1));
  }

  // ------------------------------------------------------------ scheduling

  schedulePull(): void {
    if (this.pullTimer) window.clearInterval(this.pullTimer);
    this.pullTimer = window.setInterval(() => void this.runPull(), this.settings.pullIntervalMinutes * 60_000);
    this.registerInterval(this.pullTimer);
  }

  private markDirty(f: TAbstractFile): void {
    if (!(f instanceof TFile) || f.extension !== "md") return;
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
      const editor = force ? undefined : () => this.openEditor(path);
      const res = await this.guard(() => this.engine.pushFile(path, { editor }));
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
        await vault.process(file(p), fn);
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
