import { App, Modal, Setting } from "obsidian";
import { projectTreeOrder, withDescendants, type ExportProject } from "../sync/export";

/**
 * Pick the projects to export, active and archived, nested as in Todoist. Ticking a project ticks
 * its subprojects too, and unticking unticks them; each can then be changed on its own.
 */
export class ExportModal extends Modal {
  private selected: Set<string>;
  private boxes = new Map<string, HTMLInputElement>();
  private exportButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private projects: ExportProject[],
    initial: string[],
    private onExport: (selected: Set<string>) => void,
  ) {
    super(app);
    const known = new Set(projects.map((p) => p.id));
    this.selected = new Set(initial.filter((id) => known.has(id)));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText("Export tasks to JSON");
    contentEl.createEl("p", {
      text: "Pick the projects to export. The file has every open task in them, every task completed in them since your Todoist account was made, and their completions and deletions from the activity log, with where each task is linked in your notes. It can take a minute.",
    });

    const tools = contentEl.createDiv({ cls: "inline-tasks-export-tools" });
    const all = tools.createEl("button", { text: "All" });
    all.onclick = () => this.setAll(true);
    const none = tools.createEl("button", { text: "None" });
    none.onclick = () => this.setAll(false);

    const list = contentEl.createDiv({ cls: "inline-tasks-export-list" });
    for (const p of projectTreeOrder(this.projects)) {
      const row = list.createEl("label", { cls: "inline-tasks-export-row" });
      row.style.paddingLeft = `${p.depth * 1.25}em`;
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = this.selected.has(p.id);
      box.onchange = () => this.toggle(p.id, box.checked);
      this.boxes.set(p.id, box);
      row.createSpan({ text: p.name });
      if (p.archived) row.createSpan({ cls: "inline-tasks-export-note", text: "archived" });
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        this.exportButton = b.buttonEl;
        b.setCta().onClick(() => {
          if (!this.selected.size) return;
          this.close();
          this.onExport(new Set(this.selected));
        });
      });
    this.update();
  }

  private toggle(id: string, on: boolean): void {
    for (const d of withDescendants(this.projects, id)) {
      if (on) this.selected.add(d);
      else this.selected.delete(d);
      const box = this.boxes.get(d);
      if (box) box.checked = on;
    }
    this.update();
  }

  private setAll(on: boolean): void {
    for (const [id, box] of this.boxes) {
      box.checked = on;
      if (on) this.selected.add(id);
      else this.selected.delete(id);
    }
    this.update();
  }

  private update(): void {
    const n = this.selected.size;
    if (!this.exportButton) return;
    this.exportButton.setText(n ? `Export ${n} project${n === 1 ? "" : "s"}` : "Pick a project");
    this.exportButton.disabled = !n;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
