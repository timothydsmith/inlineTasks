import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type InlineTasksPlugin from "./main";

export interface InlineTasksSettings {
  apiToken: string;
  excludedFolders: string[];
  folderProjects: { folder: string; project: string }[];
  pullIntervalMinutes: number;
  /** Whether **Import task from Todoist** brings a task's open subtasks with it. */
  importSubtasks: ImportSubtasks;
}

export type ImportSubtasks = "ask" | "always" | "never";

export const DEFAULT_SETTINGS: InlineTasksSettings = {
  apiToken: "",
  excludedFolders: ["Templates"],
  folderProjects: [],
  pullIntervalMinutes: 5,
  importSubtasks: "ask",
};

export class InlineTasksSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: InlineTasksPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Todoist API token")
      .setDesc("Todoist → Settings → Integrations → Developer → API token.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("0123abcd…")
          .setValue(s.apiToken)
          .onChange(async (v) => {
            s.apiToken = v.trim();
            await this.plugin.saveAll();
          });
      })
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          try {
            await this.plugin.engine.pull();
            const n = Object.keys(this.plugin.state.projects).length;
            new Notice(`Connected to Todoist (${n} projects)`);
            this.plugin.maybePromptBackfill();
          } catch (e) {
            new Notice(`Todoist: ${(e as Error).message}`);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Checkboxes in these folders are never synced (one per line). Add `todoist: false` to a note's frontmatter, or `#notodoist` to a line, to exclude individually.")
      .addTextArea((t) =>
        t.setValue(s.excludedFolders.join("\n")).onChange(async (v) => {
          s.excludedFolders = v.split("\n").map((x) => x.trim()).filter(Boolean);
          await this.plugin.saveAll();
        }),
      );

    new Setting(containerEl)
      .setName("Folder → project")
      .setDesc("One mapping per line, e.g. `Work = Work`. Unmapped notes go to the Inbox. A note's `todoist_project:` frontmatter overrides this.")
      .addTextArea((t) =>
        t
          .setPlaceholder("Work = Work\nHome/Garden = Garden")
          .setValue(s.folderProjects.map((m) => `${m.folder} = ${m.project}`).join("\n"))
          .onChange(async (v) => {
            s.folderProjects = v
              .split("\n")
              .map((l) => l.split("="))
              .filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
              .map(([folder, project]) => ({ folder: folder.trim(), project: project.trim() }));
            await this.plugin.saveAll();
          }),
      );

    new Setting(containerEl)
      .setName("Pull interval (minutes)")
      .setDesc("How often to fetch changes from Todoist. Also pulls when Obsidian regains focus.")
      .addText((t) =>
        t.setValue(String(s.pullIntervalMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 1) {
            s.pullIntervalMinutes = n;
            await this.plugin.saveAll();
            this.plugin.schedulePull();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Import subtasks")
      .setDesc("When you import a task from Todoist that has open subtasks, whether to insert them beneath it.")
      .addDropdown((d) =>
        d
          .addOptions({ ask: "Ask each time", always: "Always import", never: "Never import" })
          .setValue(s.importSubtasks)
          .onChange(async (v) => {
            s.importSubtasks = v as ImportSubtasks;
            await this.plugin.saveAll();
          }),
      );

    new Setting(containerEl)
      .setName("This device creates tasks")
      .setDesc("Stored per device. Turn off on secondary devices if you see duplicate tasks when using Obsidian Sync.")
      .addToggle((t) =>
        t.setValue(this.plugin.canCreate).onChange((v) => {
          this.plugin.canCreate = v;
        }),
      );

    new Setting(containerEl)
      .setName("Create tasks for changes from other devices or apps")
      .setDesc(
        "Stored per device. New checkboxes typed on this device are always created here. This decides who creates checkboxes that arrive from Obsidian Sync, a script or an agent, once the note has been quiet for 2 minutes. Keep it on for one device only (by default: on for desktop, off for mobile), so they're created once.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.createFromElsewhere).onChange((v) => {
          this.plugin.createFromElsewhere = v;
        }),
      );

    new Setting(containerEl)
      .setName("Backfill existing checkboxes")
      .setDesc(this.plugin.state.backfillDone ? "Done. New checkboxes sync automatically." : "Sync is paused until you review and confirm the backfill.")
      .addButton((b) => b.setButtonText("Review…").onClick(() => this.plugin.openBackfill()));
  }
}
