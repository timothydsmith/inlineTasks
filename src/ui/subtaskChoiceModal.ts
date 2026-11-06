import { App, Modal, Setting } from "obsidian";

/**
 * Asks whether to import a task's subtasks with it. Calls `onChoose(true|false)` for the two
 * buttons; closing the dialog any other way (Esc, the ×) cancels the import.
 */
export class SubtaskChoiceModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private count: number,
    private onChoose: (withSubtasks: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Import subtasks?");
    const n = this.count === 1 ? "1 open subtask" : `${this.count} open subtasks`;
    this.contentEl.createEl("p", { text: `“${this.title}” has ${n}. Insert them beneath it?` });
    this.contentEl.createEl("p", {
      text: "To stop being asked, choose Always or Never under Import subtasks in this plugin's settings.",
      cls: "setting-item-description",
    });
    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("Task only").onClick(() => this.choose(false)),
      )
      .addButton((b) =>
        b
          .setButtonText("With subtasks")
          .setCta()
          .onClick(() => this.choose(true)),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private choose(withSubtasks: boolean): void {
    this.close();
    this.onChoose(withSubtasks);
  }
}
